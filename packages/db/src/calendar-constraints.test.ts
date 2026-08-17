import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPrismaClient, type PrismaClient } from "./index.js";

/**
 * The calendar rules PostgreSQL enforces and TypeScript cannot see.
 * docs/phase-6-google-calendar-part-1.md §2.3, §3.6.
 *
 * Two of them, and both are load-bearing rather than tidiness:
 *
 *   - **one event per booking per calendar**, which is what makes a redelivered
 *     outbox event, a reclaimed row and a re-dispatch collapse into one row
 *     instead of putting a second appointment in somebody's diary;
 *   - **one writing calendar per provider**, a partial unique index that Prisma
 *     cannot express at all, so nothing in the generated client hints at it.
 *
 * Same reasoning as booking-constraints.test.ts next door: a constraint the
 * application relies on but never states is one a later migration can drop
 * without a single test going red.
 */

const databaseUrl = process.env["TEST_DATABASE_URL"];
const suffix = Math.random().toString(36).slice(2, 10);

describe.skipIf(!databaseUrl)("calendar constraints", () => {
  let prisma: PrismaClient;
  let tenantId: string;
  let providerId: string;
  let otherProviderId: string;
  let integrationId: string;
  let userId: string;

  beforeAll(async () => {
    prisma = createPrismaClient({ databaseUrl: databaseUrl! });

    const tenant = await prisma.tenant.create({
      data: { slug: `cal-${suffix}`, name: "Calendar Clinic" },
    });
    tenantId = tenant.id;

    const user = await prisma.user.create({
      data: { id: `usr-cal-${suffix}`, email: `cal-${suffix}@example.test`, name: "Owner" },
    });
    userId = user.id;

    const provider = await prisma.provider.create({
      data: { tenantId, displayName: "Dr. Kiss Anna", timezone: "Europe/Budapest" },
    });
    providerId = provider.id;

    const other = await prisma.provider.create({
      data: { tenantId, displayName: "Dr. Nagy Béla", timezone: "Europe/Budapest" },
    });
    otherProviderId = other.id;

    const integration = await prisma.calendarIntegration.create({
      data: { tenantId, userId, accountEmail: `google-${suffix}@example.test` },
    });
    integrationId = integration.id;
  });

  afterAll(async () => {
    await prisma.tenant.deleteMany({ where: { id: tenantId } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.$disconnect();
  });

  /** A mapping that writes, unless told otherwise. */
  const mapping = (overrides: Record<string, unknown> = {}) => ({
    tenantId,
    calendarIntegrationId: integrationId,
    providerId,
    externalCalendarId: `cal-${Math.random().toString(36).slice(2)}@group.calendar.google.com`,
    ...overrides,
  });

  describe("one writing calendar per provider", () => {
    it("refuses a second active writing calendar for the same provider", async () => {
      const first = await prisma.calendarMapping.create({ data: mapping() });

      await expect(prisma.calendarMapping.create({ data: mapping() })).rejects.toMatchObject({
        code: "P2002",
      });

      await prisma.calendarMapping.delete({ where: { id: first.id } });
    });

    it("allows a second calendar that only reads", async () => {
      // The reason the index is partial rather than plain. Part 2 lets a
      // provider read busy time from several calendars while writing to one, and
      // a bare unique index over (tenant, provider) would forbid that outright.
      const writer = await prisma.calendarMapping.create({ data: mapping() });
      const reader = await prisma.calendarMapping.create({
        data: mapping({ writeBookings: false, readBusy: true }),
      });

      expect(reader.id).not.toBe(writer.id);

      await prisma.calendarMapping.deleteMany({ where: { id: { in: [writer.id, reader.id] } } });
    });

    it("allows a replacement once the old one is deactivated", async () => {
      // The other half of why the predicate includes `active`: re-pointing a
      // provider at a different calendar must be possible without deleting the
      // row that records where their appointments already went.
      const old = await prisma.calendarMapping.create({ data: mapping() });
      await prisma.calendarMapping.update({ where: { id: old.id }, data: { active: false } });

      const replacement = await prisma.calendarMapping.create({ data: mapping() });
      expect(replacement.active).toBe(true);

      await prisma.calendarMapping.deleteMany({ where: { id: { in: [old.id, replacement.id] } } });
    });

    it("does not constrain a different provider", async () => {
      const mine = await prisma.calendarMapping.create({ data: mapping() });
      const theirs = await prisma.calendarMapping.create({
        data: mapping({ providerId: otherProviderId }),
      });

      expect(theirs.providerId).toBe(otherProviderId);

      await prisma.calendarMapping.deleteMany({ where: { id: { in: [mine.id, theirs.id] } } });
    });
  });

  describe("one event per booking per calendar", () => {
    // One writing calendar for the whole block, because the index above forbids
    // a second — which is the point of that index, and a neat demonstration that
    // it binds.
    let calendar: { id: string };

    beforeAll(async () => {
      calendar = await prisma.calendarMapping.create({ data: mapping() });
    });

    afterAll(async () => {
      await prisma.calendarMapping.deleteMany({ where: { id: calendar.id } });
    });

    it("refuses a second mapping for the same booking and calendar", async () => {
      // The mechanism the whole dispatcher leg rests on: the second insert loses,
      // and the loser has nothing to do (rule 14).
      const booking = await makeBooking();

      await prisma.calendarEventMapping.create({
        data: {
          tenantId,
          bookingId: booking.id,
          calendarMappingId: calendar.id,
          externalEventId: `bam${"a".repeat(32)}`,
          desiredVersion: 0,
        },
      });

      await expect(
        prisma.calendarEventMapping.create({
          data: {
            tenantId,
            bookingId: booking.id,
            calendarMappingId: calendar.id,
            // A different derived id must still lose: the pair is the identity,
            // not the id.
            externalEventId: `bam${"b".repeat(32)}`,
            desiredVersion: 1,
          },
        }),
      ).rejects.toMatchObject({ code: "P2002" });
    });

    it("refuses two bookings claiming one external event id", async () => {
      // The reverse lookup part 2 needs has to stay single-valued, or an event
      // arriving from Google would map to two appointments.
      const first = await makeBooking();
      const second = await makeBooking();
      const shared = `bam${"c".repeat(32)}`;

      await prisma.calendarEventMapping.create({
        data: {
          tenantId,
          bookingId: first.id,
          calendarMappingId: calendar.id,
          externalEventId: shared,
          desiredVersion: 0,
        },
      });

      await expect(
        prisma.calendarEventMapping.create({
          data: {
            tenantId,
            bookingId: second.id,
            calendarMappingId: calendar.id,
            externalEventId: shared,
            desiredVersion: 0,
          },
        }),
      ).rejects.toMatchObject({ code: "P2002" });
    });
  });

  it("keeps a live integration when its provider is archived", async () => {
    // `SetNull`, not `Cascade`. Archiving a provider is a catalogue action
    // (rule 11) and must not silently destroy a Google grant that a person
    // consented to — only they can re-consent.
    const doomed = await prisma.provider.create({
      data: { tenantId, displayName: "Leaving Soon", timezone: "Europe/Budapest" },
    });
    const integration = await prisma.calendarIntegration.create({
      data: {
        tenantId,
        userId,
        providerId: doomed.id,
        accountEmail: `leaving-${suffix}@example.test`,
      },
    });

    await prisma.provider.delete({ where: { id: doomed.id } });

    const after = await prisma.calendarIntegration.findUnique({ where: { id: integration.id } });
    expect(after).not.toBeNull();
    expect(after?.providerId).toBeNull();
    expect(after?.status).toBe("ACTIVE");
  });

  /**
   * A confirmed booking, with the catalogue rows it needs.
   *
   * `hourOffset` exists because `bookings_no_provider_overlap` is a real
   * exclusion constraint on this table — two bookings cannot share one
   * provider's time, which is rule 14 refusing a fixture rather than a bug.
   */
  let bookingSlot = 0;

  async function makeBooking() {
    const unique = Math.random().toString(36).slice(2, 10);
    const hourOffset = bookingSlot++;

    const service = await prisma.service.create({
      data: { tenantId, slug: `svc-${unique}`, name: "Consultation", durationMinutes: 30 },
    });
    const customer = await prisma.customer.create({
      data: { tenantId, fullName: "Nagy Béla", email: `c-${unique}@example.test` },
    });

    return prisma.booking.create({
      data: {
        tenantId,
        reference: `BK-${unique.toUpperCase()}`,
        customerId: customer.id,
        providerId,
        serviceId: service.id,
        startAt: new Date(Date.UTC(2026, 8, 7, 8 + hourOffset, 0, 0)),
        endAt: new Date(Date.UTC(2026, 8, 7, 8 + hourOffset, 30, 0)),
        customerNameSnapshot: "Nagy Béla",
        serviceNameSnapshot: "Consultation",
      },
    });
  }
});
