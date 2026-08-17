import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createPrismaClient, type PrismaClient } from "@bam/db";
import { deriveEventId } from "@bam/google-calendar";
import { createLogger } from "@bam/observability";

import { sweepCalendarEvents } from "./calendar.sweeper.js";
import { QueueNames, calendarJobId, type QueueRegistry } from "../queues.js";

/**
 * The catch-up path. docs/phase-6-google-calendar-part-1.md §2.2.
 *
 * Three things depend on this and nothing else: the backfill draining at all
 * (the API queues rows and enqueues nothing), a backoff ever elapsing, and
 * recovery when Redis loses a job. What it must *not* do is as important — a
 * sweep that picked up `FAILED` rows would turn "stuck, a human should look"
 * into "slow", which is §26.3's rule stated the other way round.
 */

const databaseUrl = process.env["TEST_DATABASE_URL"];
const suffix = Math.random().toString(36).slice(2, 10);

const log = createLogger({ service: "calendar-sweeper-test", level: "silent", pretty: false });

interface QueuedJob {
  queue: string;
  data: { tenantId: string; eventMappingId: string };
  opts: { jobId?: string };
}

function fakeQueues(): { registry: QueueRegistry; jobs: QueuedJob[] } {
  const jobs: QueuedJob[] = [];

  const registry = Object.fromEntries(
    Object.values(QueueNames).map((queue) => [
      queue,
      {
        add: (_name: string, data: unknown, opts: unknown) => {
          jobs.push({ queue, data, opts } as QueuedJob);
          return Promise.resolve({ id: "job" });
        },
      },
    ]),
  ) as unknown as QueueRegistry;

  return { registry, jobs };
}

describe.skipIf(!databaseUrl)("calendar sweeper", () => {
  let prisma: PrismaClient;
  let tenantId: string;
  let mappingId: string;
  let integrationId: string;

  beforeEach(async () => {
    prisma ??= createPrismaClient({ databaseUrl: databaseUrl! });

    // The sweep looks across every tenant — it is a worker, not a request — so a
    // row left by an earlier test lands in this one's batch.
    await prisma.calendarEventMapping.deleteMany({});

    const unique = `${suffix}-${Math.random().toString(36).slice(2, 8)}`;

    const tenant = await prisma.tenant.create({
      data: { slug: `sweep-${unique}`, name: "Sweep Clinic", defaultLanguage: "hu" },
    });
    tenantId = tenant.id;

    const user = await prisma.user.create({
      data: { email: `sweep-${unique}@example.test`, name: "Anna", emailVerified: true },
    });

    const provider = await prisma.provider.create({
      data: { tenantId, displayName: "Dr Teszt", timezone: "Europe/Budapest" },
    });

    const integration = await prisma.calendarIntegration.create({
      data: {
        tenantId,
        userId: user.id,
        providerId: provider.id,
        accountEmail: `anna-${unique}@gmail.com`,
      },
    });
    integrationId = integration.id;

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

  let bookingSeq = 0;

  /** A queued row, with a booking behind it. */
  async function row(
    overrides: {
      syncStatus?: "PENDING" | "SYNCING" | "SYNCED" | "FAILED";
      nextAttemptAt?: Date;
      claimedAt?: Date | null;
      attempts?: number;
      desiredVersion?: number;
    } = {},
  ) {
    const unique = `${suffix}-${(bookingSeq += 1)}`;

    const [service, customer] = await Promise.all([
      prisma.service.create({
        data: { tenantId, name: "Cleaning", slug: `clean-${unique}`, durationMinutes: 30 },
      }),
      prisma.customer.create({ data: { tenantId, fullName: "Nagy Péter" } }),
    ]);

    const mapping = await prisma.calendarMapping.findUniqueOrThrow({ where: { id: mappingId } });

    // Distinct hours: `bookings_no_provider_overlap` refuses two appointments in
    // the same slot, which is rule 14's exclusion constraint doing its job.
    const startAt = new Date(Date.now() + (24 + bookingSeq) * 3_600_000);

    const booking = await prisma.booking.create({
      data: {
        tenantId,
        // The counter, not a slice of the shared suffix: `(tenant_id, reference)`
        // is unique, and slicing produced the same string for every row.
        reference: `BK-${unique}`,
        customerId: customer.id,
        providerId: mapping.providerId,
        serviceId: service.id,
        startAt,
        endAt: new Date(startAt.getTime() + 30 * 60_000),
        status: "CONFIRMED",
        customerNameSnapshot: "Nagy Péter",
        serviceNameSnapshot: "Cleaning",
      },
    });

    return prisma.calendarEventMapping.create({
      data: {
        tenantId,
        bookingId: booking.id,
        calendarMappingId: mappingId,
        externalEventId: deriveEventId(booking.id, mappingId),
        desiredState: "PRESENT",
        desiredVersion: overrides.desiredVersion ?? 1,
        syncStatus: overrides.syncStatus ?? "PENDING",
        attempts: overrides.attempts ?? 0,
        nextAttemptAt: overrides.nextAttemptAt ?? new Date(),
        claimedAt: overrides.claimedAt ?? null,
      },
    });
  }

  const options = (registry: QueueRegistry) => ({
    prisma,
    queues: registry,
    logger: log,
    batchSize: 50,
    staleClaimSeconds: 300,
  });

  const calendarJobs = (jobs: QueuedJob[]): QueuedJob[] =>
    jobs.filter((job) => job.queue === QueueNames.CALENDAR_SYNC);

  // -------------------------------------------------------------------------

  it("enqueues a row that is due", async () => {
    const queued = await row();
    const { registry, jobs } = fakeQueues();

    const summary = await sweepCalendarEvents(options(registry));

    expect(summary).toMatchObject({ found: 1, enqueued: 1, reclaimed: 0 });

    const [job] = calendarJobs(jobs);
    expect(job!.data).toEqual({ tenantId, eventMappingId: queued.id });
    // Row, desire and attempt — so a later attempt is allowed its own job rather
    // than being silently refused by a jobId BullMQ already holds.
    expect(job!.opts.jobId).toBe(calendarJobId(queued));
  });

  it("leaves a row alone until its backoff has elapsed", async () => {
    await row({ nextAttemptAt: new Date(Date.now() + 10 * 60_000), attempts: 2 });
    const { registry, jobs } = fakeQueues();

    const summary = await sweepCalendarEvents(options(registry));

    expect(summary.found).toBe(0);
    expect(calendarJobs(jobs)).toEqual([]);
  });

  it("never picks up a parked row", async () => {
    // §26.3 forbids retrying a permanently-broken thing. A sweep that took these
    // would make FAILED mean "slow" rather than "a human should look" — and the
    // Retry button would have nothing left to mean.
    await row({ syncStatus: "FAILED", attempts: 8 });
    const { registry, jobs } = fakeQueues();

    const summary = await sweepCalendarEvents(options(registry));

    expect(summary).toMatchObject({ found: 0, enqueued: 0 });
    expect(calendarJobs(jobs)).toEqual([]);
  });

  it("ignores a row that is already synced", async () => {
    await row({ syncStatus: "SYNCED" });

    await expect(sweepCalendarEvents(options(fakeQueues().registry))).resolves.toMatchObject({
      found: 0,
    });
  });

  it("takes back a row a dead worker left syncing, without forgiving the attempt", async () => {
    // The same hole `outbox_events.claimed_at` closes. `attempts` is deliberately
    // not reset: the claim already counted the try, and a worker that died
    // mid-call may well have died because of it.
    const stale = await row({
      syncStatus: "SYNCING",
      claimedAt: new Date(Date.now() - 10 * 60_000),
      attempts: 3,
    });
    const { registry, jobs } = fakeQueues();

    const summary = await sweepCalendarEvents(options(registry));

    expect(summary.reclaimed).toBe(1);
    // Reclaimed and re-enqueued in the same pass, which is why the stale pass
    // runs first.
    expect(summary.enqueued).toBe(1);

    const after = await prisma.calendarEventMapping.findUniqueOrThrow({ where: { id: stale.id } });
    expect(after).toMatchObject({ syncStatus: "PENDING", claimedAt: null, attempts: 3 });
    expect(calendarJobs(jobs)[0]!.opts.jobId).toBe(
      calendarJobId({ id: stale.id, desiredVersion: 1, attempts: 3 }),
    );
  });

  it("leaves a fresh claim to the worker holding it", async () => {
    await row({ syncStatus: "SYNCING", claimedAt: new Date(), attempts: 1 });

    const summary = await sweepCalendarEvents(options(fakeQueues().registry));

    expect(summary).toMatchObject({ reclaimed: 0, found: 0 });
  });

  it("skips rows behind a connection that needs reconnecting", async () => {
    // Enqueueing them would be a minute-by-minute churn of jobs the processor
    // can only hand straight back. When the provider reconnects, the next pass
    // finds them — which is what "a reconnect resumes" means in practice.
    await row();
    await prisma.calendarIntegration.update({
      where: { id: integrationId },
      data: { status: "NEEDS_RECONNECT" },
    });

    const paused = await sweepCalendarEvents(options(fakeQueues().registry));
    expect(paused.found).toBe(0);

    await prisma.calendarIntegration.update({
      where: { id: integrationId },
      data: { status: "ACTIVE" },
    });

    const resumed = await sweepCalendarEvents(options(fakeQueues().registry));
    expect(resumed.enqueued).toBe(1);
  });

  it("skips rows whose calendar is no longer selected", async () => {
    await row();
    await prisma.calendarMapping.update({ where: { id: mappingId }, data: { active: false } });

    await expect(sweepCalendarEvents(options(fakeQueues().registry))).resolves.toMatchObject({
      found: 0,
    });
  });

  it("drains oldest first, and only a batch at a time", async () => {
    // The backfill's ordering carried through: the soonest appointments were
    // queued first, so taking the oldest `nextAttemptAt` first puts them in the
    // diary first too.
    const oldest = await row({ nextAttemptAt: new Date(Date.now() - 30_000) });
    const middle = await row({ nextAttemptAt: new Date(Date.now() - 20_000) });
    await row({ nextAttemptAt: new Date(Date.now() - 10_000) });

    const { registry, jobs } = fakeQueues();
    const summary = await sweepCalendarEvents({ ...options(registry), batchSize: 2 });

    expect(summary).toMatchObject({ found: 2, enqueued: 2 });
    expect(calendarJobs(jobs).map((job) => job.data.eventMappingId)).toEqual([
      oldest.id,
      middle.id,
    ]);
  });
});
