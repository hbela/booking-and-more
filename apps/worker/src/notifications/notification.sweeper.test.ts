import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createPrismaClient, type PrismaClient } from "@bam/db";
import { createLogger } from "@bam/observability";

import { sweepDueNotifications } from "./notification.sweeper.js";
import { QueueNames, type QueueRegistry } from "../queues.js";

/**
 * The sweep, against a real PostgreSQL.
 *
 * What it has to get right is a query and a horizon, both properties of the
 * database, so it runs against one. Redis is faked: "does BullMQ accept this
 * job" is not a property of our code, and the interesting assertion is which
 * rows were handed over, not what happened to them afterwards.
 */

const databaseUrl = process.env["TEST_DATABASE_URL"];
const suffix = Math.random().toString(36).slice(2, 10);

const log = createLogger({ service: "sweeper-test", level: "silent", pretty: false });

interface FakeQueue {
  added: { name: string; data: unknown; opts: unknown }[];
}

function fakeQueues(): { registry: QueueRegistry; notifications: FakeQueue } {
  const notifications: FakeQueue = { added: [] };

  const queue = {
    add: (name: string, data: unknown, opts: unknown) => {
      notifications.added.push({ name, data, opts });
      return Promise.resolve({ id: "job" });
    },
  };

  const registry = Object.fromEntries(
    Object.values(QueueNames).map((name) => [name, queue]),
  ) as unknown as QueueRegistry;

  return { registry, notifications };
}

describe.skipIf(!databaseUrl)("notification sweep", () => {
  let prisma: PrismaClient;
  let tenantId: string;

  beforeEach(async () => {
    prisma ??= createPrismaClient({ databaseUrl: databaseUrl! });

    // The sweep looks across every tenant — it is a worker, not a request — so
    // a row left by an earlier test lands in this one's batch.
    await prisma.notification.deleteMany({});

    const unique = `${suffix}-${Math.random().toString(36).slice(2, 8)}`;
    const tenant = await prisma.tenant.create({
      data: { slug: `sweep-${unique}`, name: "Sweep Clinic", defaultLanguage: "hu" },
    });
    tenantId = tenant.id;
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  const notification = (overrides: Record<string, unknown> = {}) =>
    prisma.notification.create({
      data: {
        tenantId,
        type: "BOOKING_REMINDER",
        channel: "EMAIL",
        recipient: "patient@example.test",
        template: "booking-reminder",
        locale: "hu",
        scheduledAt: new Date(),
        dedupeKey: `v1:SWEEP:${Math.random().toString(36).slice(2)}`,
        ...overrides,
      },
    });

  const options = (registry: QueueRegistry) => ({
    prisma,
    queues: registry,
    logger: log,
    batchSize: 50,
  });

  it("enqueues a row that is already due", async () => {
    const row = await notification({ scheduledAt: new Date(Date.now() - 60_000) });
    const { registry, notifications } = fakeQueues();

    const summary = await sweepDueNotifications(options(registry));

    expect(summary).toEqual({ found: 1, enqueued: 1 });
    expect((notifications.added[0]?.data as { notificationId: string }).notificationId).toBe(
      row.id,
    );
  });

  it("enqueues a reminder that has crossed the queue horizon", async () => {
    // The reason this exists. The dispatcher hands BullMQ only what is due
    // within 15 minutes; everything else is a row nothing is pointing at.
    await notification({ scheduledAt: new Date(Date.now() + 5 * 60_000) });
    const { registry, notifications } = fakeQueues();

    await sweepDueNotifications(options(registry));

    expect(notifications.added).toHaveLength(1);
    // Delayed by what is left of the wait, not sent now.
    expect((notifications.added[0]?.opts as { delay: number }).delay).toBeGreaterThan(60_000);
  });

  it("leaves a reminder still weeks out alone", async () => {
    // Delayed jobs occupy Redis for their whole delay. A reminder three weeks
    // ahead stays a row until it is close enough to matter.
    await notification({ scheduledAt: new Date(Date.now() + 21 * 24 * 60 * 60_000) });
    const { registry, notifications } = fakeQueues();

    const summary = await sweepDueNotifications(options(registry));

    expect(summary).toEqual({ found: 0, enqueued: 0 });
    expect(notifications.added).toHaveLength(0);
  });

  it("ignores rows that are no longer PENDING", async () => {
    await notification({ status: "SENT", sentAt: new Date() });
    await notification({ status: "SENDING" });
    await notification({ status: "SKIPPED" });
    await notification({ status: "FAILED" });
    const { registry, notifications } = fakeQueues();

    await sweepDueNotifications(options(registry));

    expect(notifications.added).toHaveLength(0);
  });

  it("uses the notification id as the job id", async () => {
    // Half of why the sweep needs no claim of its own: BullMQ refuses a second
    // job with an id it already holds, so a row swept twice produces one job.
    // The other half is the sender's conditional PENDING → SENDING update.
    const row = await notification({ scheduledAt: new Date(Date.now() - 1_000) });
    const { registry, notifications } = fakeQueues();

    await sweepDueNotifications(options(registry));
    await sweepDueNotifications(options(registry));

    expect(notifications.added).toHaveLength(2);
    expect(
      notifications.added.every((job) => (job.opts as { jobId: string }).jobId === row.id),
    ).toBe(true);
  });

  it("takes the oldest first and stops at the batch size", async () => {
    await notification({ scheduledAt: new Date(Date.now() - 30 * 60_000) });
    const oldest = await notification({ scheduledAt: new Date(Date.now() - 60 * 60_000) });
    await notification({ scheduledAt: new Date(Date.now() - 10 * 60_000) });
    const { registry, notifications } = fakeQueues();

    const summary = await sweepDueNotifications({ ...options(registry), batchSize: 2 });

    expect(summary).toEqual({ found: 2, enqueued: 2 });
    // A backlog drains in the order it was owed, not in index order.
    expect((notifications.added[0]?.data as { notificationId: string }).notificationId).toBe(
      oldest.id,
    );
  });
});
