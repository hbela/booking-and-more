import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BLOCKING_BOOKING_STATUSES, BookingStatuses } from "@bam/booking-engine";
import { createPrismaClient } from "./index.js";
import type { BookingStatus, PrismaClient } from "./index.js";

/**
 * The concurrency guarantee, tested where it actually lives.
 *
 * Epic 4's exit criterion "two concurrent users cannot confirm the same
 * exclusive slot" is not satisfied by any TypeScript in this repository. It is
 * satisfied by an exclusion constraint, and a constraint that is not exercised
 * is a comment. So these tests do the thing the application will do and check
 * that PostgreSQL refuses it.
 *
 * Same setup as database.test.ts: TEST_DATABASE_URL rather than Testcontainers,
 * because there is no Docker on the development machine (tech-impl §39.3).
 */

const databaseUrl = process.env["TEST_DATABASE_URL"];

const suffix = Math.random().toString(36).slice(2, 10);

describe.skipIf(!databaseUrl)("booking constraints", () => {
  let prisma: PrismaClient;
  let tenantId: string;
  let providerId: string;
  let otherProviderId: string;
  let serviceId: string;
  let customerId: string;

  beforeAll(async () => {
    prisma = createPrismaClient({ databaseUrl: databaseUrl! });

    const tenant = await prisma.tenant.create({
      data: { slug: `constraints-${suffix}`, name: "Constraint Clinic" },
    });
    tenantId = tenant.id;

    const [provider, other] = await Promise.all([
      prisma.provider.create({
        data: { tenantId, displayName: "Dr. Anna", timezone: "Europe/Budapest" },
      }),
      prisma.provider.create({
        data: { tenantId, displayName: "Dr. Béla", timezone: "Europe/Budapest" },
      }),
    ]);
    providerId = provider.id;
    otherProviderId = other.id;

    const service = await prisma.service.create({
      data: { tenantId, name: "Cleaning", slug: `cleaning-${suffix}`, durationMinutes: 30 },
    });
    serviceId = service.id;

    const customer = await prisma.customer.create({
      data: { tenantId, fullName: "Nagy Péter" },
    });
    customerId = customer.id;
  });

  afterAll(async () => {
    if (tenantId) {
      // Explicit order rather than relying on the tenant cascade: bookings hold
      // a RESTRICT reference to customers, and a cascade that reached customers
      // first would trip over it.
      await prisma.capacityReservation.deleteMany({ where: { tenantId } });
      await prisma.booking.deleteMany({ where: { tenantId } });
      await prisma.bookingHold.deleteMany({ where: { tenantId } });
      await prisma.customer.deleteMany({ where: { tenantId } });
      await prisma.tenant.delete({ where: { id: tenantId } });
    }
    await prisma.$disconnect();
  });

  // -------------------------------------------------------------------------
  // The gate
  // -------------------------------------------------------------------------

  describe("capacity_reservations_no_overlap", () => {
    /**
     * Hold then reservation, in that order — the same two writes the API makes
     * inside one transaction. Every ACTIVE reservation needs an owner and a
     * hold-owned one needs an expiry, so a bare hold satisfies both CHECKs.
     */
    const reserve = async (args: {
      startAt: string;
      endAt: string;
      provider?: string;
      status?: "ACTIVE" | "RELEASED";
      expiresAt?: Date | null;
    }) => {
      const provider = args.provider ?? providerId;

      const hold = await prisma.bookingHold.create({
        data: {
          tenantId,
          providerId: provider,
          serviceId,
          sessionId: `session-${Math.random().toString(36).slice(2)}`,
          startAt: new Date(args.startAt),
          endAt: new Date(args.endAt),
          expiresAt: new Date("2030-01-01T00:00:00Z"),
        },
      });

      return prisma.capacityReservation.create({
        data: {
          tenantId,
          providerId: provider,
          holdId: hold.id,
          startAt: new Date(args.startAt),
          endAt: new Date(args.endAt),
          status: args.status ?? "ACTIVE",
          expiresAt:
            args.expiresAt === undefined ? new Date("2030-01-01T00:00:00Z") : args.expiresAt,
        },
      });
    };

    it("refuses a second active reservation overlapping the first", async () => {
      // The whole exit criterion in one assertion. Nothing in application code
      // decides this; the database does, which is why it is still true when two
      // requests arrive in the same millisecond.
      await reserve({ startAt: "2026-09-01T09:00:00Z", endAt: "2026-09-01T09:30:00Z" });

      await expect(
        reserve({ startAt: "2026-09-01T09:15:00Z", endAt: "2026-09-01T09:45:00Z" }),
      ).rejects.toThrow();
    });

    it("allows back-to-back reservations", async () => {
      // Half-open ranges: 10:30 ends one and starts the next. This must agree
      // with @bam/booking-engine's spansOverlap and the availability engine's
      // interval algebra.
      await reserve({ startAt: "2026-09-02T10:00:00Z", endAt: "2026-09-02T10:30:00Z" });

      await expect(
        reserve({ startAt: "2026-09-02T10:30:00Z", endAt: "2026-09-02T11:00:00Z" }),
      ).resolves.toBeDefined();
    });

    it("allows a different provider at the same time", async () => {
      await reserve({ startAt: "2026-09-03T09:00:00Z", endAt: "2026-09-03T09:30:00Z" });

      await expect(
        reserve({
          startAt: "2026-09-03T09:00:00Z",
          endAt: "2026-09-03T09:30:00Z",
          provider: otherProviderId,
        }),
      ).resolves.toBeDefined();
    });

    it("ignores released reservations", async () => {
      // The predicate is WHERE status = 'ACTIVE'. A released hold must put its
      // slot back on sale, or an abandoned checkout would cost the slot forever.
      await reserve({
        startAt: "2026-09-04T09:00:00Z",
        endAt: "2026-09-04T09:30:00Z",
        status: "RELEASED",
      });

      await expect(
        reserve({ startAt: "2026-09-04T09:00:00Z", endAt: "2026-09-04T09:30:00Z" }),
      ).resolves.toBeDefined();
    });

    it("still blocks a slot whose hold has expired but not been swept", async () => {
      // Deliberately asserting the awkward truth rather than the wish. An
      // exclusion constraint's predicate cannot call now(), so an expired
      // reservation goes on blocking until something rewrites its status. This
      // is exactly why the API sweeps inside the hold-creation transaction, and
      // why that sweep is correctness rather than housekeeping.
      await reserve({
        startAt: "2026-09-05T09:00:00Z",
        endAt: "2026-09-05T09:30:00Z",
        expiresAt: new Date("2020-01-01T00:00:00Z"),
      });

      await expect(
        reserve({ startAt: "2026-09-05T09:00:00Z", endAt: "2026-09-05T09:30:00Z" }),
      ).rejects.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // The backstop
  // -------------------------------------------------------------------------

  describe("bookings_no_provider_overlap", () => {
    let sequence = 0;

    const book = (args: { startAt: string; endAt: string; status: BookingStatus }) =>
      prisma.booking.create({
        data: {
          tenantId,
          reference: `BK-${suffix}-${String(++sequence)}`,
          customerId,
          providerId,
          serviceId,
          startAt: new Date(args.startAt),
          endAt: new Date(args.endAt),
          status: args.status,
          customerNameSnapshot: "Nagy Péter",
          serviceNameSnapshot: "Cleaning",
          ...(args.status === "CANCELLED" ? { cancelledAt: new Date() } : {}),
        },
      });

    it("blocks the diary for exactly the statuses the engine calls blocking", async () => {
      // The assertion the migration comment promises. The status list exists
      // twice — as SQL in the exclusion predicate and as TypeScript in
      // BLOCKING_BOOKING_STATUSES — and a disagreement between them is either a
      // double booking or a slot nobody can ever book. This is the only place
      // the two are compared.
      const day = "2026-10-01";
      await book({
        startAt: `${day}T09:00:00Z`,
        endAt: `${day}T09:30:00Z`,
        status: "CONFIRMED",
      });

      for (const status of Object.values(BookingStatuses)) {
        const attempt = book({
          startAt: `${day}T09:15:00Z`,
          endAt: `${day}T09:45:00Z`,
          status,
        });

        if (BLOCKING_BOOKING_STATUSES.includes(status)) {
          await expect(attempt, `${status} must conflict`).rejects.toThrow();
        } else {
          await expect(attempt, `${status} must not conflict`).resolves.toBeDefined();
          // Clear it, so the next iteration is tested against the CONFIRMED row
          // alone rather than against whatever the previous one left behind.
          await prisma.booking.deleteMany({
            where: { tenantId, startAt: new Date(`${day}T09:15:00Z`) },
          });
        }
      }
    });

    it("compares appointment times, not occupied windows", async () => {
      // Deliberately weaker than the reservation constraint. Two appointments
      // whose buffers overlap are a real conflict, and the reservation table
      // catches it; encoding buffer policy here would mean a migration every
      // time a service's buffers changed.
      await book({
        startAt: "2026-10-02T09:00:00Z",
        endAt: "2026-10-02T09:30:00Z",
        status: "CONFIRMED",
      });

      await expect(
        book({
          startAt: "2026-10-02T09:30:00Z",
          endAt: "2026-10-02T10:00:00Z",
          status: "CONFIRMED",
        }),
      ).resolves.toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // Well-formed rows
  // -------------------------------------------------------------------------

  describe("check constraints", () => {
    it("refuses a backwards reservation", async () => {
      const hold = await prisma.bookingHold.create({
        data: {
          tenantId,
          providerId,
          serviceId,
          sessionId: "backwards",
          startAt: new Date("2026-11-01T09:00:00Z"),
          endAt: new Date("2026-11-01T10:00:00Z"),
          expiresAt: new Date("2030-01-01T00:00:00Z"),
        },
      });

      await expect(
        prisma.capacityReservation.create({
          data: {
            tenantId,
            providerId,
            holdId: hold.id,
            startAt: new Date("2026-11-01T10:00:00Z"),
            endAt: new Date("2026-11-01T09:00:00Z"),
            expiresAt: new Date("2030-01-01T00:00:00Z"),
          },
        }),
      ).rejects.toThrow();
    });

    it("refuses a backwards hold", async () => {
      await expect(
        prisma.bookingHold.create({
          data: {
            tenantId,
            providerId,
            serviceId,
            sessionId: "backwards-hold",
            startAt: new Date("2026-11-01T10:00:00Z"),
            endAt: new Date("2026-11-01T09:00:00Z"),
            expiresAt: new Date("2030-01-01T00:00:00Z"),
          },
        }),
      ).rejects.toThrow();
    });

    it("refuses an active reservation that nothing owns", async () => {
      // Nothing links to it, so nothing will ever release it: it would block its
      // slot until somebody noticed by hand.
      await expect(
        prisma.capacityReservation.create({
          data: {
            tenantId,
            providerId,
            startAt: new Date("2026-11-02T09:00:00Z"),
            endAt: new Date("2026-11-02T09:30:00Z"),
            expiresAt: new Date("2030-01-01T00:00:00Z"),
          },
        }),
      ).rejects.toThrow();
    });

    it("refuses an active hold-owned reservation with no expiry", async () => {
      // It would be immortal: invisible to the sweep, blocking its slot for good.
      const hold = await prisma.bookingHold.create({
        data: {
          tenantId,
          providerId,
          serviceId,
          sessionId: "immortal",
          startAt: new Date("2026-11-03T09:00:00Z"),
          endAt: new Date("2026-11-03T09:30:00Z"),
          expiresAt: new Date("2030-01-01T00:00:00Z"),
        },
      });

      await expect(
        prisma.capacityReservation.create({
          data: {
            tenantId,
            providerId,
            holdId: hold.id,
            startAt: new Date("2026-11-03T09:00:00Z"),
            endAt: new Date("2026-11-03T09:30:00Z"),
            expiresAt: null,
          },
        }),
      ).rejects.toThrow();
    });

    it("refuses a hold that expires before it exists", async () => {
      await expect(
        prisma.bookingHold.create({
          data: {
            tenantId,
            providerId,
            serviceId,
            sessionId: "already-dead",
            startAt: new Date("2026-11-04T09:00:00Z"),
            endAt: new Date("2026-11-04T09:30:00Z"),
            expiresAt: new Date("2020-01-01T00:00:00Z"),
          },
        }),
      ).rejects.toThrow();
    });

    it("refuses a price without a currency, and a currency without a price", async () => {
      const base = {
        tenantId,
        customerId,
        providerId,
        serviceId,
        startAt: new Date("2026-11-05T09:00:00Z"),
        endAt: new Date("2026-11-05T09:30:00Z"),
        customerNameSnapshot: "Nagy Péter",
        serviceNameSnapshot: "Cleaning",
      };

      await expect(
        prisma.booking.create({
          data: { ...base, reference: `BK-${suffix}-price`, priceMinorSnapshot: 12_000 },
        }),
      ).rejects.toThrow();

      await expect(
        prisma.booking.create({
          data: { ...base, reference: `BK-${suffix}-currency`, currencySnapshot: "HUF" },
        }),
      ).rejects.toThrow();
    });

    it("refuses a cancelled booking that does not say when", async () => {
      // The one fact a dispute turns on. `updated_at` is not it — a later edit
      // overwrites it.
      await expect(
        prisma.booking.create({
          data: {
            tenantId,
            reference: `BK-${suffix}-cancelled`,
            customerId,
            providerId,
            serviceId,
            startAt: new Date("2026-11-06T09:00:00Z"),
            endAt: new Date("2026-11-06T09:30:00Z"),
            status: "CANCELLED",
            customerNameSnapshot: "Nagy Péter",
            serviceNameSnapshot: "Cleaning",
          },
        }),
      ).rejects.toThrow();
    });
  });
});
