import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createPrismaClient, type PrismaClient } from "@bam/db";
import { deriveEventId } from "@bam/google-calendar";
import { createLogger } from "@bam/observability";

import { dispatchOutboxBatch } from "../outbox/outbox.dispatcher.js";
import { dispatchCalendarLeg } from "./calendar.leg.js";
import { QueueNames, calendarJobId, type QueueRegistry } from "../queues.js";

/**
 * The second leg of the outbox dispatch.
 * docs/phase-6-google-calendar-part-1.md §2.2, §2.4.
 *
 * Driven through `dispatchOutboxBatch` rather than by calling the leg directly
 * wherever possible, because "one claim, two legs" is the property under test —
 * a leg that works in isolation and never runs is the failure this is guarding
 * against.
 *
 * The step's acceptance criterion lives next door: every test in
 * `outbox.dispatcher.test.ts` stays green **with no edit**, because with no
 * calendar connected this leg is one indexed `SELECT` returning nothing. That
 * file is deliberately untouched.
 *
 * ## PARKED 2026-08-17 — Epic 6 part 1
 *
 * The call to `dispatchCalendarLeg` inside `dispatchOutboxBatch` is commented
 * out, so the nine tests that drive through the dispatcher observe nothing.
 * That is the parking working, not a regression — and the property above is
 * exactly why the suite is skipped whole rather than trimmed to the six that
 * still pass: "the leg runs on the same claim" is what it exists to assert, and
 * a suite that no longer asserts it would go green for the wrong reason.
 *
 * `calendar.processor.test.ts` and `calendar.sweeper.test.ts` are deliberately
 * NOT parked — they call their modules directly, still pass, and keep the
 * parked code honest while it waits.
 */

const databaseUrl = process.env["TEST_DATABASE_URL"];
/** Un-park: drop this and restore `!databaseUrl` in the `skipIf` below. */
const parked = true;
const suffix = Math.random().toString(36).slice(2, 10);

const log = createLogger({ service: "calendar-leg-test", level: "silent", pretty: false });

interface QueuedJob {
  queue: string;
  name: string;
  data: { tenantId: string; eventMappingId: string };
  opts: { jobId?: string };
}

function fakeQueues(): { registry: QueueRegistry; jobs: QueuedJob[] } {
  const jobs: QueuedJob[] = [];

  const registry = Object.fromEntries(
    Object.values(QueueNames).map((queue) => [
      queue,
      {
        add: (name: string, data: unknown, opts: unknown) => {
          jobs.push({ queue, name, data, opts } as QueuedJob);
          return Promise.resolve({ id: "job" });
        },
      },
    ]),
  ) as unknown as QueueRegistry;

  return { registry, jobs };
}

const calendarJobs = (jobs: QueuedJob[]): QueuedJob[] =>
  jobs.filter((job) => job.queue === QueueNames.CALENDAR_SYNC);

describe.skipIf(parked || !databaseUrl)("calendar leg", () => {
  let prisma: PrismaClient;
  let tenantId: string;
  let providerId: string;
  let bookingId: string;
  let mappingId: string;

  const options = (registry: QueueRegistry) => ({
    prisma,
    queues: registry,
    logger: log,
    batchSize: 50,
    maxAttempts: 5,
    reminderLeadHours: 24,
    appBaseUrl: "http://localhost:3000",
  });

  beforeEach(async () => {
    prisma ??= createPrismaClient({ databaseUrl: databaseUrl! });

    // The dispatcher claims across every tenant — it is a worker, not a request
    // — so a stray event from an earlier test lands in this one's batch.
    await prisma.outboxEvent.deleteMany({});

    const unique = `${suffix}-${Math.random().toString(36).slice(2, 8)}`;

    const tenant = await prisma.tenant.create({
      data: { slug: `leg-${unique}`, name: "Leg Clinic", defaultLanguage: "hu" },
    });
    tenantId = tenant.id;

    const user = await prisma.user.create({
      data: { email: `leg-${unique}@example.test`, name: "Anna", emailVerified: true },
    });

    const provider = await prisma.provider.create({
      data: { tenantId, displayName: "Dr Teszt", timezone: "Europe/Budapest" },
    });
    providerId = provider.id;

    const service = await prisma.service.create({
      data: { tenantId, name: "Cleaning", slug: `cleaning-${unique}`, durationMinutes: 30 },
    });

    const customer = await prisma.customer.create({
      data: { tenantId, fullName: "Nagy Péter", email: "peter@example.com" },
    });

    const booking = await prisma.booking.create({
      data: {
        tenantId,
        reference: `BK-${unique.slice(0, 6).toUpperCase()}`,
        customerId: customer.id,
        providerId: provider.id,
        serviceId: service.id,
        startAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1_000),
        endAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1_000 + 30 * 60 * 1_000),
        status: "CONFIRMED",
        version: 1,
        customerNameSnapshot: "Nagy Péter",
        customerEmailSnapshot: "peter@example.com",
        serviceNameSnapshot: "Cleaning",
      },
    });
    bookingId = booking.id;

    const integration = await prisma.calendarIntegration.create({
      data: {
        tenantId,
        userId: user.id,
        providerId: provider.id,
        accountEmail: `anna-${unique}@gmail.com`,
      },
    });

    const mapping = await prisma.calendarMapping.create({
      data: {
        tenantId,
        calendarIntegrationId: integration.id,
        providerId: provider.id,
        externalCalendarId: `anna-${unique}@gmail.com`,
      },
    });
    mappingId = mapping.id;
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  const writeEvent = (eventType: string) =>
    prisma.outboxEvent.create({
      data: {
        tenantId,
        eventType,
        aggregateType: "Booking",
        aggregateId: bookingId,
        payload: { bookingId },
      },
    });

  const rows = () =>
    prisma.calendarEventMapping.findMany({ where: { tenantId, bookingId } });

  // -------------------------------------------------------------------------
  // The happy path, through the real dispatcher
  // -------------------------------------------------------------------------

  it("queues one row and one job for a confirmed booking", async () => {
    await writeEvent("BOOKING_CONFIRMED");
    const { registry, jobs } = fakeQueues();

    const summary = await dispatchOutboxBatch(options(registry));

    expect(summary.processed).toBe(1);
    expect(summary.calendarQueued).toBe(1);
    // The notification leg still ran on the same claim — that is the whole
    // point of the arrangement, and a leg that quietly replaced the other would
    // pass every calendar assertion below.
    expect(summary.notificationsCreated).toBe(2);

    const queued = await rows();
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({
      calendarMappingId: mappingId,
      desiredState: "PRESENT",
      desiredVersion: 1,
      syncStatus: "PENDING",
      syncedVersion: null,
      externalEventId: deriveEventId(bookingId, mappingId),
    });

    const enqueued = calendarJobs(jobs);
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]!.data).toEqual({ tenantId, eventMappingId: queued[0]!.id });
    // Row, desire and attempt together — a re-dispatch of the same desire
    // collapses into one job, while a *new* desire gets its own rather than
    // being silently refused by a jobId BullMQ already holds.
    expect(enqueued[0]!.opts.jobId).toBe(calendarJobId(queued[0]!));
  });

  it("does nothing at all when no calendar is connected", async () => {
    // The acceptance criterion for this step, asserted directly rather than
    // only implied by the neighbouring suite staying green.
    await prisma.calendarMapping.delete({ where: { id: mappingId } });
    await writeEvent("BOOKING_CONFIRMED");
    const { registry, jobs } = fakeQueues();

    const summary = await dispatchOutboxBatch(options(registry));

    expect(summary.processed).toBe(1);
    expect(summary.calendarQueued).toBe(0);
    expect(summary.notificationsCreated).toBe(2);
    expect(await rows()).toEqual([]);
    expect(calendarJobs(jobs)).toEqual([]);
  });

  it("ignores a calendar that is no longer selected", async () => {
    await prisma.calendarMapping.update({ where: { id: mappingId }, data: { active: false } });
    await writeEvent("BOOKING_CONFIRMED");

    const summary = await dispatchOutboxBatch(options(fakeQueues().registry));

    expect(summary.calendarQueued).toBe(0);
    expect(await rows()).toEqual([]);
  });

  it("records the desire even while the connection needs reconnecting", async () => {
    // The desire is ours, the grant is Google's. Recording it now is what makes
    // a reconnection *resume* — the processor holds the row until somebody
    // re-consents (§5), and a leg that skipped would lose the booking entirely.
    await prisma.calendarIntegration.updateMany({
      where: { tenantId },
      data: { status: "NEEDS_RECONNECT" },
    });
    await writeEvent("BOOKING_CONFIRMED");

    const summary = await dispatchOutboxBatch(options(fakeQueues().registry));

    expect(summary.calendarQueued).toBe(1);
    expect(await rows()).toHaveLength(1);
  });

  it("writes nothing for a booking nobody has accepted", async () => {
    // Record §3.8. The slot is still held by us, so nothing is oversold — but an
    // appointment nobody agreed to must not appear in a provider's diary.
    await prisma.booking.update({ where: { id: bookingId }, data: { status: "PENDING" } });
    await writeEvent("BOOKING_REQUESTED");

    const summary = await dispatchOutboxBatch(options(fakeQueues().registry));

    expect(summary.calendarQueued).toBe(0);
    expect(await rows()).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Repetition and ordering — §2.4
  // -------------------------------------------------------------------------

  it("collapses a redelivered event into the one row", async () => {
    await writeEvent("BOOKING_CONFIRMED");
    const first = fakeQueues();
    await dispatchOutboxBatch(options(first.registry));

    // The same event again, at the same booking version.
    await writeEvent("BOOKING_CONFIRMED");
    const second = fakeQueues();
    const summary = await dispatchOutboxBatch(options(second.registry));

    expect(await rows()).toHaveLength(1);
    // Nothing moved, so nothing was queued: the guard is `<`, not `<=`.
    expect(summary.calendarQueued).toBe(0);
    expect(calendarJobs(second.jobs)).toEqual([]);
  });

  it("advances the row when the booking is rescheduled", async () => {
    await writeEvent("BOOKING_CONFIRMED");
    await dispatchOutboxBatch(options(fakeQueues().registry));

    // Pretend the worker got there: the row is settled at version 1.
    await prisma.calendarEventMapping.updateMany({
      where: { tenantId, bookingId },
      data: { syncStatus: "SYNCED", syncedVersion: 1, externalEventEtag: '"v1"' },
    });

    // Both ends move together: `bookings_range` refuses an appointment that
    // finishes before it starts, which is the database keeping a reschedule
    // honest rather than the test being fussy.
    const movedTo = new Date(Date.now() + 8 * 24 * 60 * 60 * 1_000);
    await prisma.booking.update({
      where: { id: bookingId },
      data: {
        version: 2,
        startAt: movedTo,
        endAt: new Date(movedTo.getTime() + 30 * 60 * 1_000),
      },
    });
    await writeEvent("BOOKING_RESCHEDULED");

    const { registry, jobs } = fakeQueues();
    const summary = await dispatchOutboxBatch(options(registry));

    expect(summary.calendarQueued).toBe(1);
    expect(calendarJobs(jobs)).toHaveLength(1);

    const [row] = await rows();
    expect(row).toMatchObject({
      desiredState: "PRESENT",
      desiredVersion: 2,
      syncStatus: "PENDING",
      // Still 1: Google holds the old version, and that is exactly what tells
      // the processor to patch rather than insert.
      syncedVersion: 1,
    });
  });

  it("leaves the row alone when a stale event arrives after a newer one", async () => {
    // **The test §2.4 exists for.** Outbox rows are claimed oldest-first, but a
    // retry reorders them — so a redelivered BOOKING_RESCHEDULED can land after
    // the cancellation that superseded it. Without the version guard it would
    // resurrect the event of a booking that is no longer happening.
    await writeEvent("BOOKING_CONFIRMED");
    await dispatchOutboxBatch(options(fakeQueues().registry));

    // The booking is cancelled: version 3, and the leg records that.
    await prisma.booking.update({
      where: { id: bookingId },
      data: { status: "CANCELLED", cancelledAt: new Date(), version: 3 },
    });
    await dispatchCalendarLeg(
      { tenantId, aggregateType: "Booking", aggregateId: bookingId },
      { prisma, queues: fakeQueues().registry, logger: log },
    );

    const [cancelled] = await rows();
    expect(cancelled).toMatchObject({ desiredState: "CANCELLED", desiredVersion: 3 });

    // Now the stale reschedule finally gets its retry, carrying an older reading
    // of the booking.
    const { registry, jobs } = fakeQueues();
    await prisma.booking.update({ where: { id: bookingId }, data: { version: 2 } });
    const late = await dispatchCalendarLeg(
      { tenantId, aggregateType: "Booking", aggregateId: bookingId },
      { prisma, queues: registry, logger: log },
    );

    expect(late.queued).toBe(0);
    expect(calendarJobs(jobs)).toEqual([]);

    const [after] = await rows();
    expect(after).toMatchObject({ desiredState: "CANCELLED", desiredVersion: 3 });
  });

  it("takes the booking's current status over the event's name", async () => {
    // A BOOKING_CONFIRMED redelivered after a cancellation. Read literally it
    // asks for the event to be present; read against the booking, it does not.
    await writeEvent("BOOKING_CONFIRMED");
    await dispatchOutboxBatch(options(fakeQueues().registry));

    await prisma.booking.update({
      where: { id: bookingId },
      data: { status: "CANCELLED", cancelledAt: new Date(), version: 2 },
    });
    await writeEvent("BOOKING_CONFIRMED");

    await dispatchOutboxBatch(options(fakeQueues().registry));

    const [row] = await rows();
    expect(row).toMatchObject({ desiredState: "CANCELLED", desiredVersion: 2 });
  });

  // -------------------------------------------------------------------------
  // Cancellation
  // -------------------------------------------------------------------------

  it("greys out a booking that had reached a calendar", async () => {
    await writeEvent("BOOKING_CONFIRMED");
    await dispatchOutboxBatch(options(fakeQueues().registry));

    await prisma.calendarEventMapping.updateMany({
      where: { tenantId, bookingId },
      data: { syncStatus: "SYNCED", syncedVersion: 1 },
    });
    await prisma.booking.update({
      where: { id: bookingId },
      data: { status: "CANCELLED", cancelledAt: new Date(), version: 2 },
    });
    await writeEvent("BOOKING_CANCELLED");

    const summary = await dispatchOutboxBatch(options(fakeQueues().registry));

    expect(summary.calendarQueued).toBe(1);
    expect((await rows())[0]).toMatchObject({
      desiredState: "CANCELLED",
      desiredVersion: 2,
      syncStatus: "PENDING",
    });
  });

  it("creates nothing to cancel a booking that never reached one", async () => {
    // No row means nothing was ever written to a calendar. Inserting one would
    // queue a job whose only work is to discover it has none.
    await prisma.booking.update({
      where: { id: bookingId },
      data: { status: "CANCELLED", cancelledAt: new Date(), version: 2 },
    });
    await writeEvent("BOOKING_CANCELLED");

    const summary = await dispatchOutboxBatch(options(fakeQueues().registry));

    expect(summary.processed).toBe(1);
    expect(summary.calendarQueued).toBe(0);
    expect(await rows()).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Recovery and isolation
  // -------------------------------------------------------------------------

  it("gives a parked row a fresh budget for a new desire", async () => {
    // What failed is not what is being asked for now: a row parked against
    // version 1 should not carry that verdict into version 2.
    await writeEvent("BOOKING_CONFIRMED");
    await dispatchOutboxBatch(options(fakeQueues().registry));

    await prisma.calendarEventMapping.updateMany({
      where: { tenantId, bookingId },
      data: { syncStatus: "FAILED", attempts: 8, lastError: "backendError" },
    });

    await prisma.booking.update({ where: { id: bookingId }, data: { version: 2 } });
    await writeEvent("BOOKING_RESCHEDULED");
    await dispatchOutboxBatch(options(fakeQueues().registry));

    expect((await rows())[0]).toMatchObject({
      syncStatus: "PENDING",
      attempts: 0,
      lastError: null,
      desiredVersion: 2,
    });
  });

  it("will not write into another tenant's calendar", async () => {
    // Rule 5. The mapping is found by `(tenantId, providerId)`, so a booking
    // whose provider somehow matched would still be refused by the tenant half.
    const other = await dispatchCalendarLeg(
      { tenantId: "not-this-tenant", aggregateType: "Booking", aggregateId: bookingId },
      { prisma, queues: fakeQueues().registry, logger: log },
    );

    expect(other.queued).toBe(0);
    expect(await rows()).toEqual([]);
  });

  it("ignores an aggregate type that is not a booking", async () => {
    const result = await dispatchCalendarLeg(
      { tenantId, aggregateType: "Tenant", aggregateId: tenantId },
      { prisma, queues: fakeQueues().registry, logger: log },
    );

    expect(result.queued).toBe(0);
  });

  it("fans out to every calendar the provider writes to", async () => {
    // The partial unique index allows only one *writing* calendar per provider
    // today, so a second has to come from a second integration — the shape a
    // future relaxation would take. The loop is already correct for it.
    const secondUser = await prisma.user.create({
      data: {
        email: `second-${suffix}-${Math.random().toString(36).slice(2, 6)}@example.test`,
        name: "Second",
        emailVerified: true,
      },
    });

    const second = await prisma.calendarIntegration.create({
      data: {
        tenantId,
        userId: secondUser.id,
        providerId,
        accountEmail: `second-${Math.random().toString(36).slice(2, 8)}@gmail.com`,
      },
    });

    // `writeBookings: false` keeps the partial index satisfied while proving the
    // filter: this calendar must *not* receive the booking.
    await prisma.calendarMapping.create({
      data: {
        tenantId,
        calendarIntegrationId: second.id,
        providerId,
        externalCalendarId: "read-only@group.calendar.google.com",
        writeBookings: false,
      },
    });

    await writeEvent("BOOKING_CONFIRMED");
    const summary = await dispatchOutboxBatch(options(fakeQueues().registry));

    expect(summary.calendarQueued).toBe(1);
    expect((await rows()).map((row) => row.calendarMappingId)).toEqual([mappingId]);
  });
});
