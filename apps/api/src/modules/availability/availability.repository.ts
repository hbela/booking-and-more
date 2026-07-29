import type { AvailabilityException, Prisma, PrismaClient, WorkingHours } from "@bam/db";
import { ErrorCodes, NotFoundError } from "@bam/contracts";
import { isRecordNotFound } from "../providers/provider.repository.js";

/**
 * Data access for schedules.
 *
 * `tenantId` on every call, in every `where` (CLAUDE.md rule 5). Availability is
 * the most attractive thing to read across a tenant boundary — it is a
 * competitor's staffing levels — so the rule matters here as much as anywhere.
 */
export class AvailabilityRepository {
  constructor(private readonly prisma: PrismaClient) {}

  // --- Claimed time ---------------------------------------------------------

  /**
   * What is already taken on these providers' diaries.
   *
   * Reads `capacity_reservations` and nothing else. That table is what the
   * exclusion constraint enforces, so it is the only source that cannot
   * disagree with the answer the database will give when somebody tries to
   * book: querying `bookings` and `booking_holds` separately would mean
   * assembling the same fact from two places and hoping the assembly matches.
   *
   * Rows already carry the occupied window, buffers included, so nothing here
   * recomputes a span (Epic 4, part 1).
   */
  async listBusyReservations(args: {
    tenantId: string;
    providerIds: string[];
    from: Date;
    to: Date;
    /** Reservations whose holds lapsed before this are treated as free. */
    now: Date;
    /** A booking whose own reservation is about to move — see the slot search. */
    excludeBookingId?: string;
  }): Promise<{ providerId: string; bookingId: string | null; startAt: Date; endAt: Date }[]> {
    if (args.providerIds.length === 0) return [];

    return this.prisma.capacityReservation.findMany({
      where: {
        tenantId: args.tenantId,
        providerId: { in: args.providerIds },
        status: "ACTIVE",
        // Half-open overlap, matching the engine and the constraint.
        startAt: { lt: args.to },
        endAt: { gt: args.from },
        // An expired hold's reservation is still ACTIVE in the database until
        // something sweeps it, and it still blocks the exclusion constraint —
        // but it does not mean the slot is taken, and showing it as taken would
        // hide a free appointment for as long as nobody tried to book near it.
        // The sweep runs inside the transaction that claims the slot, so a
        // customer who books what this offers still succeeds.
        OR: [{ expiresAt: null }, { expiresAt: { gt: args.now } }],
        ...(args.excludeBookingId === undefined
          ? {}
          : { NOT: { bookingId: args.excludeBookingId } }),
      },
      select: { providerId: true, bookingId: true, startAt: true, endAt: true },
    });
  }

  // --- Working hours --------------------------------------------------------

  async listWorkingHours(args: {
    tenantId: string;
    providerId: string;
    /** Only rows that apply at this location, plus the location-agnostic ones. */
    locationId?: string | undefined;
    activeOnly?: boolean;
  }): Promise<WorkingHours[]> {
    return this.prisma.workingHours.findMany({
      where: {
        tenantId: args.tenantId,
        providerId: args.providerId,
        ...(args.activeOnly === true ? { active: true } : {}),
        // A row with no location applies wherever the provider works, so it is
        // always in scope; a row naming a different site is not.
        ...(args.locationId === undefined
          ? {}
          : { OR: [{ locationId: null }, { locationId: args.locationId }] }),
      },
      orderBy: [{ weekday: "asc" }, { startTime: "asc" }],
    });
  }

  /**
   * Replace a provider's whole week in one transaction.
   *
   * Delete-then-insert rather than a diff: the rows carry no identity anybody
   * refers to, and a diff would be more code for the sole benefit of preserving
   * ids nothing reads.
   */
  async replaceWorkingHours(args: {
    tenantId: string;
    providerId: string;
    rows: Omit<Prisma.WorkingHoursUncheckedCreateInput, "tenantId" | "providerId">[];
  }): Promise<WorkingHours[]> {
    const { tenantId, providerId, rows } = args;

    return this.prisma.$transaction(async (tx) => {
      await tx.workingHours.deleteMany({ where: { tenantId, providerId } });

      if (rows.length > 0) {
        await tx.workingHours.createMany({
          data: rows.map((row) => ({ ...row, tenantId, providerId })),
        });
      }

      return tx.workingHours.findMany({
        where: { tenantId, providerId },
        orderBy: [{ weekday: "asc" }, { startTime: "asc" }],
      });
    });
  }

  // --- Exceptions -----------------------------------------------------------

  /** Exceptions overlapping `[from, to)`. */
  async listExceptions(args: {
    tenantId: string;
    providerId: string;
    from: Date;
    to: Date;
  }): Promise<AvailabilityException[]> {
    return this.prisma.availabilityException.findMany({
      where: {
        tenantId: args.tenantId,
        providerId: args.providerId,
        // Overlap, not containment: a week-long closure must be found by a
        // query about the Wednesday in the middle of it.
        startAt: { lt: args.to },
        endAt: { gt: args.from },
      },
      orderBy: { startAt: "asc" },
    });
  }

  async findException(args: {
    tenantId: string;
    exceptionId: string;
  }): Promise<AvailabilityException | null> {
    return this.prisma.availabilityException.findFirst({
      where: { id: args.exceptionId, tenantId: args.tenantId },
    });
  }

  async findExceptionOrThrow(args: {
    tenantId: string;
    exceptionId: string;
  }): Promise<AvailabilityException> {
    const exception = await this.findException(args);
    if (!exception) throw exceptionNotFound();
    return exception;
  }

  async createException(args: {
    tenantId: string;
    data: Omit<Prisma.AvailabilityExceptionUncheckedCreateInput, "tenantId">;
  }): Promise<AvailabilityException> {
    return this.prisma.availabilityException.create({
      data: { ...args.data, tenantId: args.tenantId },
    });
  }

  async updateException(args: {
    tenantId: string;
    exceptionId: string;
    data: Prisma.AvailabilityExceptionUncheckedUpdateInput;
  }): Promise<AvailabilityException> {
    try {
      return await this.prisma.availabilityException.update({
        where: { id: args.exceptionId, tenantId: args.tenantId },
        data: args.data,
      });
    } catch (error) {
      if (isRecordNotFound(error)) throw exceptionNotFound();
      throw error;
    }
  }

  /**
   * Hard delete, unlike the catalogue.
   *
   * An exception is a statement about time that has not happened yet. Removing
   * "I am away next Tuesday" leaves nothing worth keeping — there is no booking
   * pointing at it and no history it explains, which is exactly what makes the
   * catalogue's archive-instead rule not apply here.
   */
  async deleteException(args: { tenantId: string; exceptionId: string }): Promise<void> {
    const result = await this.prisma.availabilityException.deleteMany({
      where: { id: args.exceptionId, tenantId: args.tenantId },
    });

    if (result.count === 0) throw exceptionNotFound();
  }
}

export function exceptionNotFound(): NotFoundError {
  return new NotFoundError("Availability exception not found.", ErrorCodes.NOT_FOUND);
}
