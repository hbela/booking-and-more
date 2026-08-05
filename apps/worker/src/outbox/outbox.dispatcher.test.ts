import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createPrismaClient, type PrismaClient } from "@bam/db";
import { createLogger } from "@bam/observability";

import { dispatchOutboxBatch } from "./outbox.dispatcher.js";
import { QueueNames, type QueueRegistry } from "../queues.js";

/**
 * The dispatcher, against a real PostgreSQL.
 *
 * These are integration tests on purpose. Everything interesting here is a
 * property of the database — `FOR UPDATE SKIP LOCKED` refusing to hand one row
 * to two workers, the unique index refusing a duplicate notification — and a
 * mocked Prisma would assert only that the code calls the methods it calls.
 *
 * Same arrangement as @bam/db's suites: TEST_DATABASE_URL rather than
 * Testcontainers (tech-impl §39.3).
 */

const databaseUrl = process.env["TEST_DATABASE_URL"];
const suffix = Math.random().toString(36).slice(2, 10);

const log = createLogger({ service: "worker-test", level: "silent", pretty: false });

/** Records what was enqueued without needing Redis. */
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

describe.skipIf(!databaseUrl)("outbox dispatcher", () => {
  let prisma: PrismaClient;
  let tenantId: string;
  let bookingId: string;
  let customerId: string;
  let providerId: string;

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

    // The dispatcher claims across every tenant — it is a worker, not a
    // request — so a stray event from an earlier test lands in this one's
    // batch and inflates its counts. Each test starts from an empty outbox.
    await prisma.outboxEvent.deleteMany({});

    const unique = `${suffix}-${Math.random().toString(36).slice(2, 8)}`;

    const tenant = await prisma.tenant.create({
      data: { slug: `dispatch-${unique}`, name: "Dispatch Clinic", defaultLanguage: "hu" },
    });
    tenantId = tenant.id;

    const [provider, service, customer] = await Promise.all([
      prisma.provider.create({
        data: { tenantId, displayName: "Dr Teszt", timezone: "Europe/Budapest" },
      }),
      prisma.service.create({
        data: { tenantId, name: "Cleaning", slug: `cleaning-${unique}`, durationMinutes: 30 },
      }),
      prisma.customer.create({
        data: {
          tenantId,
          fullName: "Nagy Péter",
          email: "peter@example.com",
          preferredLanguage: "hu",
        },
      }),
    ]);
    customerId = customer.id;
    providerId = provider.id;

    const booking = await prisma.booking.create({
      data: {
        tenantId,
        reference: `BK-${unique.slice(0, 6).toUpperCase()}`,
        customerId,
        providerId: provider.id,
        serviceId: service.id,
        // Far enough out that a 24-hour reminder is still in the future.
        startAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1_000),
        endAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1_000 + 30 * 60 * 1_000),
        status: "CONFIRMED",
        customerNameSnapshot: "Nagy Péter",
        customerEmailSnapshot: "peter@example.com",
        serviceNameSnapshot: "Cleaning",
      },
    });
    bookingId = booking.id;
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

  const notificationsFor = () =>
    prisma.notification.findMany({ where: { tenantId, bookingId }, orderBy: { type: "asc" } });

  describe("BOOKING_CONFIRMED", () => {
    it("creates a confirmation and a reminder, and marks the event processed", async () => {
      const event = await writeEvent("BOOKING_CONFIRMED");
      const { registry } = fakeQueues();

      const summary = await dispatchOutboxBatch(options(registry));

      expect(summary.claimed).toBe(1);
      expect(summary.processed).toBe(1);
      expect(summary.notificationsCreated).toBe(2);

      const rows = await notificationsFor();
      expect(rows.map((row) => row.type)).toEqual(["BOOKING_CONFIRMATION", "BOOKING_REMINDER"]);

      const settled = await prisma.outboxEvent.findUniqueOrThrow({ where: { id: event.id } });
      expect(settled.status).toBe("PROCESSED");
      expect(settled.processedAt).not.toBeNull();
      expect(settled.claimedAt).toBeNull();
    });

    it("records the address the customer was told, not the customer's current one", async () => {
      // Rule 15: the booking's snapshot is what was promised.
      await prisma.customer.update({
        where: { id: customerId },
        data: { email: "moved@example.com" },
      });
      await writeEvent("BOOKING_CONFIRMED");

      await dispatchOutboxBatch(options(fakeQueues().registry));

      const rows = await notificationsFor();
      expect(rows.every((row) => row.recipient === "peter@example.com")).toBe(true);
    });

    it("enqueues the confirmation but leaves the distant reminder for the sweep", async () => {
      // Delayed jobs occupy Redis for the whole delay; a reminder a week out
      // stays a database row until it is close enough to matter.
      await writeEvent("BOOKING_CONFIRMED");
      const { registry, notifications } = fakeQueues();

      await dispatchOutboxBatch(options(registry));

      expect(notifications.added).toHaveLength(1);
      const [job] = notifications.added;
      expect((job?.data as { tenantId: string }).tenantId).toBe(tenantId);
    });

    it("uses the notification id as the job id, so a re-dispatch cannot double up", async () => {
      await writeEvent("BOOKING_CONFIRMED");
      const { registry, notifications } = fakeQueues();

      await dispatchOutboxBatch(options(registry));

      const confirmation = (await notificationsFor()).find(
        (row) => row.type === "BOOKING_CONFIRMATION",
      );
      expect((notifications.added[0]?.opts as { jobId: string }).jobId).toBe(confirmation?.id);
    });
  });

  describe("duplicate suppression", () => {
    it("sends nothing extra when the same event is dispatched twice", async () => {
      // Epic 5's third exit criterion. Two identical events — the API wrote
      // one twice, or a claim was reclaimed after a crash.
      await writeEvent("BOOKING_CONFIRMED");
      await dispatchOutboxBatch(options(fakeQueues().registry));

      await writeEvent("BOOKING_CONFIRMED");
      const second = await dispatchOutboxBatch(options(fakeQueues().registry));

      expect(second.notificationsCreated).toBe(0);
      expect(second.notificationsDuplicate).toBe(2);
      expect(second.processed).toBe(1);

      expect(await notificationsFor()).toHaveLength(2);
    });

    it("gives a second reschedule its own message", async () => {
      // The bug a dedupe on (type, bookingId) would introduce: a booking moved
      // twice owes two emails.
      await prisma.booking.update({ where: { id: bookingId }, data: { version: 1 } });
      await writeEvent("BOOKING_RESCHEDULED");
      await dispatchOutboxBatch(options(fakeQueues().registry));

      await prisma.booking.update({ where: { id: bookingId }, data: { version: 2 } });
      await writeEvent("BOOKING_RESCHEDULED");
      const second = await dispatchOutboxBatch(options(fakeQueues().registry));

      expect(second.notificationsCreated).toBe(1);

      const updates = (await notificationsFor()).filter((row) => row.type === "BOOKING_UPDATED");
      expect(updates).toHaveLength(2);
    });
  });

  describe("current facts, not stale ones", () => {
    it("sends no confirmation for a booking cancelled since the event was written", async () => {
      await writeEvent("BOOKING_CONFIRMED");
      // `bookings_cancelled_at_present` requires the two to move together.
      await prisma.booking.update({
        where: { id: bookingId },
        data: { status: "CANCELLED", cancelledAt: new Date() },
      });

      const summary = await dispatchOutboxBatch(options(fakeQueues().registry));

      expect(summary.processed).toBe(1);
      expect(summary.notificationsCreated).toBe(0);
      expect(await notificationsFor()).toHaveLength(0);
    });

    it("plans nothing for a booking with no email address", async () => {
      await prisma.booking.update({
        where: { id: bookingId },
        data: { customerEmailSnapshot: null },
      });
      await writeEvent("BOOKING_CONFIRMED");

      const summary = await dispatchOutboxBatch(options(fakeQueues().registry));

      // Processed, not failed: a phone booking with no address is a correct
      // outcome, not something to retry.
      expect(summary.processed).toBe(1);
      expect(summary.failed).toBe(0);
      expect(await notificationsFor()).toHaveLength(0);
    });
  });

  describe("events this dispatcher does not handle", () => {
    it("processes an unrecognised event type without failing it", async () => {
      const event = await writeEvent("AVAILABILITY_CHANGED");

      const summary = await dispatchOutboxBatch(options(fakeQueues().registry));

      expect(summary.notificationsCreated).toBe(0);
      const settled = await prisma.outboxEvent.findUniqueOrThrow({ where: { id: event.id } });
      expect(settled.status).toBe("PROCESSED");
    });

    it("processes an event for a non-booking aggregate", async () => {
      const event = await prisma.outboxEvent.create({
        data: {
          tenantId,
          eventType: "CALENDAR_SYNC_REQUESTED",
          aggregateType: "CalendarIntegration",
          aggregateId: "cal_1",
          payload: {},
        },
      });

      await dispatchOutboxBatch(options(fakeQueues().registry));

      const settled = await prisma.outboxEvent.findUniqueOrThrow({ where: { id: event.id } });
      expect(settled.status).toBe("PROCESSED");
    });
  });

  describe("PROVIDER_INVITED", () => {
    // Spelled out rather than `Record<string, unknown>`, which Prisma's JSON
    // input type refuses — an index signature admits `undefined`, and the
    // column cannot hold it.
    const writeInvite = (payload: {
      email?: string;
      providerName?: string;
      invitedByName?: string;
      invitationToken?: string;
      expiresAt?: string;
    }) =>
      prisma.outboxEvent.create({
        data: {
          tenantId,
          eventType: "PROVIDER_INVITED",
          // The branch that exists because `dispatchOne` otherwise routes every
          // non-Booking aggregate into a debug-logged no-op.
          aggregateType: "Provider",
          aggregateId: providerId,
          payload,
        },
      });

    const invitePayload = {
      email: "anna@example.test",
      providerName: "Dr Teszt",
      invitedByName: "Nagy Béla",
      invitationToken: "tok_abc123",
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1_000).toISOString(),
    };

    it("creates one email carrying a link the sender could not rebuild", async () => {
      await writeInvite(invitePayload);
      const { registry, notifications } = fakeQueues();

      const summary = await dispatchOutboxBatch(options(registry));

      expect(summary.notificationsCreated).toBe(1);

      const [notification] = await prisma.notification.findMany({
        where: { tenantId, type: "PROVIDER_INVITED" },
      });
      expect(notification).toMatchObject({
        recipient: "anna@example.test",
        template: "provider-invited",
        // The organization's language, not the provider's `languages[]`.
        locale: "hu",
      });
      // Only a hash of the token is stored, so this payload is the one copy.
      expect(notification!.payload).toMatchObject({
        acceptUrl: "http://localhost:3000/invitations/tok_abc123",
        organizationName: "Dispatch Clinic",
        providerName: "Dr Teszt",
        invitedByName: "Nagy Béla",
      });
      expect(notifications.added).toHaveLength(1);
    });

    it("prefixes the link with the locale for an English organization", async () => {
      // An unprefixed path *is* the Hungarian URL, so an English recipient used
      // to be sent to a Hungarian screen.
      await prisma.tenant.update({ where: { id: tenantId }, data: { defaultLanguage: "en" } });
      await writeInvite(invitePayload);

      await dispatchOutboxBatch(options(fakeQueues().registry));

      const [notification] = await prisma.notification.findMany({
        where: { tenantId, type: "PROVIDER_INVITED" },
      });
      expect(notification!.locale).toBe("en");
      expect(notification!.payload).toMatchObject({
        acceptUrl: "http://localhost:3000/en/invitations/tok_abc123",
      });
    });

    it("sends again for a resend, because a resend means the first did not arrive", async () => {
      await writeInvite(invitePayload);
      await writeInvite({ ...invitePayload, invitationToken: "tok_second" });

      const summary = await dispatchOutboxBatch(options(fakeQueues().registry));

      // The dedupe key is the event id, not the provider — keying on the
      // provider would swallow every resend, which is the recovery path.
      expect(summary.notificationsCreated).toBe(2);
    });

    it("treats a cleared payload as already dispatched rather than a failure", async () => {
      // markProcessed clears the payload to bound the token's exposure; a
      // re-claim between the clear and the status write must be a no-op.
      const event = await writeInvite({});

      const summary = await dispatchOutboxBatch(options(fakeQueues().registry));

      expect(summary.notificationsCreated).toBe(0);
      const settled = await prisma.outboxEvent.findUniqueOrThrow({ where: { id: event.id } });
      expect(settled.status).toBe("PROCESSED");
    });

    it("still sends when the diary has been renamed away, falling back to the payload", async () => {
      await writeInvite(invitePayload);
      await prisma.provider.update({
        where: { id: providerId },
        data: { displayName: "Somebody Else" },
      });

      await dispatchOutboxBatch(options(fakeQueues().registry));

      const [notification] = await prisma.notification.findMany({
        where: { tenantId, type: "PROVIDER_INVITED" },
      });
      // The live row wins when it is there — the greeting should match what the
      // organization calls this person today.
      expect(notification!.payload).toMatchObject({ providerName: "Somebody Else" });
    });
  });

  describe("claiming", () => {
    it("counts the attempt at claim time so a crash loop still terminates", async () => {
      const event = await writeEvent("BOOKING_CONFIRMED");

      await dispatchOutboxBatch(options(fakeQueues().registry));

      const settled = await prisma.outboxEvent.findUniqueOrThrow({ where: { id: event.id } });
      expect(settled.attempts).toBe(1);
    });

    it("does not claim an event whose availableAt is in the future", async () => {
      await prisma.outboxEvent.create({
        data: {
          tenantId,
          eventType: "BOOKING_CONFIRMED",
          aggregateType: "Booking",
          aggregateId: bookingId,
          payload: { bookingId },
          availableAt: new Date(Date.now() + 60 * 60 * 1_000),
        },
      });

      const summary = await dispatchOutboxBatch(options(fakeQueues().registry));
      expect(summary.claimed).toBe(0);
    });

    it("hands a row to only one of two concurrent dispatchers", async () => {
      // The reason the claim is one statement with FOR UPDATE SKIP LOCKED.
      await writeEvent("BOOKING_CONFIRMED");

      const [first, second] = await Promise.all([
        dispatchOutboxBatch(options(fakeQueues().registry)),
        dispatchOutboxBatch(options(fakeQueues().registry)),
      ]);

      expect(first.claimed + second.claimed).toBe(1);
    });

    it("respects the batch size", async () => {
      await Promise.all([
        writeEvent("BOOKING_CONFIRMED"),
        writeEvent("BOOKING_RESCHEDULED"),
        writeEvent("BOOKING_CANCELLED"),
      ]);

      const summary = await dispatchOutboxBatch({
        ...options(fakeQueues().registry),
        batchSize: 2,
      });

      expect(summary.claimed).toBe(2);
    });
  });
});
