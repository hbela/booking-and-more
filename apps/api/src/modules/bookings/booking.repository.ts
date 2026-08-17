import { createHash, randomBytes } from "node:crypto";
import type { Booking, BookingHold, Prisma, PrismaClient } from "@bam/db";
import { ConflictError, ErrorCodes, NotFoundError } from "@bam/contracts";
import { decodeCursor, takeFor } from "../../lib/pagination.js";

/**
 * Anything inside a `$transaction` callback, or the client itself.
 *
 * The booking writes are multi-statement and every one of them has to be atomic,
 * so the methods that participate take the client explicitly rather than closing
 * over `this.prisma`. Passing the wrong one is then a type error rather than a
 * transaction that silently is not one.
 */
export type Db = Prisma.TransactionClient | PrismaClient;

export type BookingWithRelations = Prisma.BookingGetPayload<{
  include: { provider: true; service: true; location: true; customer: true };
}>;

const BOOKING_INCLUDE = {
  provider: true,
  service: true,
  location: true,
  customer: true,
} as const;

/**
 * Data access for bookings, holds and reservations.
 *
 * `tenantId` is a required parameter on every method and appears in every
 * `where` clause (CLAUDE.md rule 5) — with exactly one documented exception,
 * {@link findByManagementToken}, where the token *is* the credential.
 */
export class BookingRepository {
  constructor(private readonly prisma: PrismaClient) {}

  // -------------------------------------------------------------------------
  // Expiry sweep
  // -------------------------------------------------------------------------

  /**
   * Release reservations whose holds have run out.
   *
   * This is correctness, not housekeeping, and it is the direct consequence of
   * a fact asserted in packages/db/src/booking-constraints.test.ts: an
   * exclusion constraint's predicate cannot call `now()`, so a reservation
   * whose `expires_at` has passed goes on blocking its slot until something
   * rewrites its status. With no scheduler until Epic 5, that something is this.
   *
   * It runs inside the transaction that is about to try to claim a slot, which
   * is the one moment the answer is guaranteed to matter. Scoped to the
   * provider being booked rather than the whole table: a sweep is a write, and
   * a global one would have every concurrent booking contending on rows none of
   * them care about.
   *
   * Ordering matters. Reservations are released first; if the transaction
   * aborts between the two statements, nothing is committed at all.
   */
  async sweepExpired(db: Db, args: { providerId: string; now: Date }): Promise<number> {
    const { count } = await db.capacityReservation.updateMany({
      where: {
        providerId: args.providerId,
        status: "ACTIVE",
        expiresAt: { not: null, lte: args.now },
      },
      data: { status: "RELEASED" },
    });

    if (count > 0) {
      await db.bookingHold.updateMany({
        where: { providerId: args.providerId, status: "ACTIVE", expiresAt: { lte: args.now } },
        data: { status: "EXPIRED" },
      });
    }

    return count;
  }

  // -------------------------------------------------------------------------
  // Holds
  // -------------------------------------------------------------------------

  /**
   * Insert a hold and the reservation that guards its slot.
   *
   * The reservation carries the *occupied* span (buffers included); the hold
   * carries the appointment. A conflicting reservation makes the second INSERT
   * fail, which is exactly the intent — see {@link isSlotConflict}.
   */
  async createHold(
    db: Db,
    args: {
      tenantId: string;
      data: {
        providerId: string;
        serviceId: string;
        locationId: string | null;
        customerId: string | null;
        sessionId: string;
        startAt: Date;
        endAt: Date;
        expiresAt: Date;
      };
      occupied: { startAt: Date; endAt: Date };
    },
  ): Promise<BookingHold> {
    const hold = await db.bookingHold.create({
      data: { ...args.data, tenantId: args.tenantId },
    });

    await db.capacityReservation.create({
      data: {
        tenantId: args.tenantId,
        providerId: args.data.providerId,
        holdId: hold.id,
        startAt: args.occupied.startAt,
        endAt: args.occupied.endAt,
        expiresAt: args.data.expiresAt,
      },
    });

    return hold;
  }

  async findHold(args: { tenantId: string; holdId: string }): Promise<BookingHold | null> {
    return this.prisma.bookingHold.findFirst({
      where: { id: args.holdId, tenantId: args.tenantId },
    });
  }

  async findHoldOrThrow(args: { tenantId: string; holdId: string }): Promise<BookingHold> {
    const hold = await this.findHold(args);
    if (!hold) throw holdNotFound();
    return hold;
  }

  /**
   * Load a hold for update, taking a row lock. tech-impl §11.5 step 1.
   *
   * Prisma has no `FOR UPDATE`, so this is raw. Without it two confirmations of
   * one hold can both read it ACTIVE and both proceed; the capacity constraint
   * would stop the second reservation, but only after a customer record and a
   * booking row had been written for a booking that cannot exist.
   */
  async lockHold(db: Db, args: { tenantId: string; holdId: string }): Promise<BookingHold> {
    // Two statements on purpose. `$queryRaw` returns the database's own column
    // names — `expires_at`, not `expiresAt` — because it bypasses the mapping
    // in schema.prisma entirely, so `SELECT *` here would hand back an object
    // that type-checks as a BookingHold and is nothing of the sort. The raw
    // query takes the lock and returns only the id; Prisma then reads the row
    // properly, and the lock is held for the rest of the transaction either
    // way.
    const locked = await db.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "booking_holds"
      WHERE "id" = ${args.holdId} AND "tenant_id" = ${args.tenantId}
      FOR UPDATE
    `;

    if (locked.length === 0) throw holdNotFound();

    const hold = await db.bookingHold.findFirst({
      where: { id: args.holdId, tenantId: args.tenantId },
    });
    if (!hold) throw holdNotFound();
    return hold;
  }

  async releaseHold(db: Db, args: { tenantId: string; holdId: string }): Promise<void> {
    await db.bookingHold.updateMany({
      where: { id: args.holdId, tenantId: args.tenantId },
      data: { status: "RELEASED" },
    });

    await db.capacityReservation.updateMany({
      where: { tenantId: args.tenantId, holdId: args.holdId, status: "ACTIVE" },
      data: { status: "RELEASED" },
    });
  }

  // -------------------------------------------------------------------------
  // Bookings
  // -------------------------------------------------------------------------

  async list(args: {
    tenantId: string;
    limit: number;
    cursor?: string | undefined;
    /**
     * The diaries this page may cover. `undefined` means every diary in the
     * tenant, which only a caller holding `booking:read:all` may ask for — the
     * route decides that and never passes an empty array, because an empty
     * array here would be an empty page and the caller meant a refusal
     * (docs/phase-3-4-diary-delegation.md §4.3).
     */
    providerIds?: readonly string[] | undefined;
    customerId?: string | undefined;
    status?: Booking["status"][] | undefined;
    from?: Date | undefined;
    to?: Date | undefined;
  }): Promise<BookingWithRelations[]> {
    const cursor = args.cursor === undefined ? undefined : decodeCursor(args.cursor);

    return this.prisma.booking.findMany({
      where: {
        tenantId: args.tenantId,
        ...(args.providerIds === undefined ? {} : { providerId: { in: [...args.providerIds] } }),
        ...(args.customerId === undefined ? {} : { customerId: args.customerId }),
        ...(args.status === undefined ? {} : { status: { in: args.status } }),
        ...(args.from === undefined && args.to === undefined
          ? {}
          : {
              startAt: {
                ...(args.from === undefined ? {} : { gte: args.from }),
                ...(args.to === undefined ? {} : { lte: args.to }),
              },
            }),
        // Keyset over (startAt, id): start times are not unique — a clinic with
        // three chairs has three bookings at 09:00 — so the id breaks the tie.
        ...(cursor === undefined
          ? {}
          : {
              OR: [
                { startAt: { gt: new Date(cursor.sortValue) } },
                { startAt: new Date(cursor.sortValue), id: { gt: cursor.id } },
              ],
            }),
      },
      include: BOOKING_INCLUDE,
      orderBy: [{ startAt: "asc" }, { id: "asc" }],
      take: takeFor(args.limit),
    });
  }

  async findById(args: {
    tenantId: string;
    bookingId: string;
  }): Promise<BookingWithRelations | null> {
    return this.prisma.booking.findFirst({
      where: { id: args.bookingId, tenantId: args.tenantId },
      include: BOOKING_INCLUDE,
    });
  }

  async findByIdOrThrow(args: {
    tenantId: string;
    bookingId: string;
  }): Promise<BookingWithRelations> {
    const booking = await this.findById(args);
    if (!booking) throw bookingNotFound();
    return booking;
  }

  /**
   * The one method without a `tenantId`, and the reason is worth stating.
   *
   * A management link is what a customer gets in their confirmation email. They
   * have no account, no session and no idea what a tenant id is; the token *is*
   * the credential, and it selects the tenant rather than being scoped by one.
   * Rule 5 exists to stop a tenant being inferred from ambient state — here it
   * is derived from a 32-byte secret the caller had to possess.
   *
   * Only the hash is stored (tech-impl §34.4), so a database leak does not hand
   * over working links. The tenantId this returns is what scopes everything the
   * caller does next.
   */
  async findByManagementToken(token: string): Promise<BookingWithRelations | null> {
    return this.prisma.booking.findUnique({
      where: { managementTokenHash: hashToken(token) },
      include: BOOKING_INCLUDE,
    });
  }

  async createBooking(
    db: Db,
    args: {
      tenantId: string;
      data: Omit<Prisma.BookingUncheckedCreateInput, "tenantId">;
    },
  ): Promise<Booking> {
    return db.booking.create({ data: { ...args.data, tenantId: args.tenantId } });
  }

  /**
   * Hand the hold's reservation to the booking. tech-impl §11.5 step 6.
   *
   * An update rather than a delete-and-insert: the row stays ACTIVE throughout,
   * so the slot is never unguarded for even an instant of the transaction.
   * `expiresAt` is cleared because a booking does not time out, and `holdId`
   * stays so the lineage remains readable.
   */
  async adoptReservation(
    db: Db,
    args: { tenantId: string; holdId: string; bookingId: string },
  ): Promise<void> {
    const { count } = await db.capacityReservation.updateMany({
      where: { tenantId: args.tenantId, holdId: args.holdId, status: "ACTIVE" },
      data: { bookingId: args.bookingId, expiresAt: null },
    });

    if (count === 0) {
      // The hold was locked and checked usable moments ago, so its reservation
      // must exist. Reaching here means something released it out from under
      // us; failing loudly beats writing a booking with nothing guarding it.
      throw new ConflictError(
        ErrorCodes.SLOT_NO_LONGER_AVAILABLE,
        "This appointment was just reserved by another customer.",
      );
    }
  }

  /** A reservation owned directly by a booking — the staff path, with no hold. */
  async createBookingReservation(
    db: Db,
    args: {
      tenantId: string;
      providerId: string;
      bookingId: string;
      startAt: Date;
      endAt: Date;
    },
  ): Promise<void> {
    await db.capacityReservation.create({
      data: {
        tenantId: args.tenantId,
        providerId: args.providerId,
        bookingId: args.bookingId,
        startAt: args.startAt,
        endAt: args.endAt,
      },
    });
  }

  /**
   * Move a booking's reservation to a new span.
   *
   * One statement, so the exclusion constraint re-checks the new window against
   * everything else. If the new time collides the transaction aborts and the
   * old reservation is still there — which is what makes rescheduling
   * transactional rather than a release followed by a hopeful re-acquire.
   */
  async moveReservation(
    db: Db,
    args: { tenantId: string; bookingId: string; startAt: Date; endAt: Date },
  ): Promise<void> {
    const { count } = await db.capacityReservation.updateMany({
      where: { tenantId: args.tenantId, bookingId: args.bookingId, status: "ACTIVE" },
      data: { startAt: args.startAt, endAt: args.endAt },
    });

    if (count === 0) {
      throw new ConflictError(
        ErrorCodes.SLOT_NO_LONGER_AVAILABLE,
        "This appointment no longer holds its place in the diary.",
      );
    }
  }

  async releaseBookingReservation(
    db: Db,
    args: { tenantId: string; bookingId: string },
  ): Promise<void> {
    await db.capacityReservation.updateMany({
      where: { tenantId: args.tenantId, bookingId: args.bookingId, status: "ACTIVE" },
      data: { status: "RELEASED" },
    });
  }

  /**
   * Write a booking with an optimistic-locking check.
   *
   * `version` guards against two staff members editing one booking from two
   * screens: the second write finds no row at the version it read and is told
   * to look again, rather than silently overwriting the first.
   */
  async updateBooking(
    db: Db,
    args: {
      tenantId: string;
      bookingId: string;
      expectedVersion: number;
      data: Prisma.BookingUncheckedUpdateInput;
    },
  ): Promise<Booking> {
    const { count } = await db.booking.updateMany({
      where: { id: args.bookingId, tenantId: args.tenantId, version: args.expectedVersion },
      data: { ...args.data, version: { increment: 1 } },
    });

    if (count === 0) {
      throw new ConflictError(
        ErrorCodes.BOOKING_NOT_MODIFIABLE,
        "This booking was changed by someone else. Reload it and try again.",
      );
    }

    const booking = await db.booking.findFirst({
      where: { id: args.bookingId, tenantId: args.tenantId },
    });
    if (!booking) throw bookingNotFound();
    return booking;
  }

  /** Active reservations overlapping a window — what the slot search subtracts. */
  async busyPeriods(args: {
    tenantId: string;
    providerIds: string[];
    from: Date;
    to: Date;
  }): Promise<{ providerId: string; startAt: Date; endAt: Date }[]> {
    return this.prisma.capacityReservation.findMany({
      where: {
        tenantId: args.tenantId,
        providerId: { in: args.providerIds },
        status: "ACTIVE",
        startAt: { lt: args.to },
        endAt: { gt: args.from },
      },
      select: { providerId: true, startAt: true, endAt: true },
    });
  }

  // -------------------------------------------------------------------------
  // Reference and management token
  // -------------------------------------------------------------------------

  /**
   * A short code a customer can read out over the phone.
   *
   * Crockford-ish alphabet: no I, O, U or 1, so nothing is misheard as
   * something else and nothing accidentally spells a word. Uniqueness is per
   * tenant and enforced by the database; a collision retries rather than
   * failing, because at 32^6 the retry effectively never happens and a booking
   * lost to a reference clash would be absurd.
   */
  async allocateReference(db: Db, tenantId: string): Promise<string> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const reference = randomReference();
      const clash = await db.booking.findFirst({
        where: { tenantId, reference },
        select: { id: true },
      });
      if (!clash) return reference;
    }

    throw new ConflictError(
      ErrorCodes.INTERNAL_ERROR,
      "Could not allocate a booking reference. Please try again.",
    );
  }
}

const REFERENCE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTVWXYZ";

function randomReference(): string {
  const bytes = randomBytes(6);
  let out = "";
  for (const byte of bytes) {
    out += REFERENCE_ALPHABET[byte % REFERENCE_ALPHABET.length];
  }
  return out;
}

/**
 * A management token and its stored hash. tech-impl §34.4.
 *
 * 32 bytes of CSPRNG output, so plain SHA-256 is right — there is no
 * low-entropy guess space for a slow hash to protect, and what matters is that
 * the stored value is not usable. Same scheme as invitation tokens.
 */
export function createManagementToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: hashToken(token) };
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function bookingNotFound(): NotFoundError {
  return new NotFoundError("Booking not found.", ErrorCodes.BOOKING_NOT_FOUND);
}

export function holdNotFound(): NotFoundError {
  return new NotFoundError("This reservation no longer exists.", ErrorCodes.HOLD_NOT_FOUND);
}

/**
 * Did PostgreSQL refuse this write because the slot is taken?
 *
 * `23P01` is `exclusion_violation`. Prisma surfaces it as P2010 (raw query
 * failure) or as a generic known-request error depending on the path, and the
 * driver message carries the constraint name, so both the code and the text are
 * checked. This is the single place the database's answer to "who got there
 * first" is translated into ours.
 */
export function isSlotConflict(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;

  const candidate = error as { code?: unknown; meta?: { code?: unknown }; message?: unknown };

  if (candidate.code === "23P01" || candidate.meta?.code === "23P01") return true;

  return (
    typeof candidate.message === "string" &&
    (candidate.message.includes("23P01") ||
      candidate.message.includes("exclusion constraint") ||
      candidate.message.includes("_no_overlap") ||
      candidate.message.includes("no_provider_overlap"))
  );
}

export function slotTaken(): ConflictError {
  return new ConflictError(
    ErrorCodes.SLOT_NO_LONGER_AVAILABLE,
    "This appointment was just reserved by another customer.",
  );
}
