import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createPrismaClient, type PrismaClient } from "@bam/db";
import { createLogger } from "@bam/observability";

import { sendNotification } from "./notification.sender.js";
import type { DeliveryResult, EmailMessage, EmailProvider } from "../email/email.provider.js";

/**
 * The sender, against a real PostgreSQL and a fake provider.
 *
 * The database half is what matters — claiming a row exactly once, and
 * recording the right terminal state — so it is real. The provider is faked
 * because "does Resend accept this" is not a property of our code.
 */

const databaseUrl = process.env["TEST_DATABASE_URL"];
const suffix = Math.random().toString(36).slice(2, 10);

const log = createLogger({ service: "sender-test", level: "silent", pretty: false });

function provider(result: DeliveryResult): EmailProvider & { sent: EmailMessage[] } {
  const sent: EmailMessage[] = [];

  return {
    name: "fake",
    sent,
    send(message: EmailMessage) {
      sent.push(message);
      return Promise.resolve(result);
    },
  };
}

describe.skipIf(!databaseUrl)("notification sender", () => {
  let prisma: PrismaClient;
  let tenantId: string;

  beforeEach(async () => {
    prisma ??= createPrismaClient({ databaseUrl: databaseUrl! });

    const unique = `${suffix}-${Math.random().toString(36).slice(2, 8)}`;
    const tenant = await prisma.tenant.create({
      data: { slug: `sender-${unique}`, name: "Sender Clinic", defaultLanguage: "en" },
    });
    tenantId = tenant.id;
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  const createNotification = (overrides: Record<string, unknown> = {}) =>
    prisma.notification.create({
      data: {
        tenantId,
        type: "ORGANIZATION_CREATED",
        channel: "EMAIL",
        recipient: "owner@example.test",
        template: "organization-created",
        locale: "en",
        scheduledAt: new Date(),
        dedupeKey: `v1:ORGANIZATION_CREATED:EMAIL:${Math.random().toString(36).slice(2)}`,
        payload: {
          organizationName: "Wellness Kft",
          ownerName: "Kovács Anna",
          acceptUrl: "http://localhost:3000/invitations/tok123",
          expiresAt: new Date().toISOString(),
        },
        ...overrides,
      },
    });

  const options = (p: EmailProvider) => ({ prisma, provider: p, logger: log, maxAttempts: 5 });

  it("sends and records the provider's message id", async () => {
    const notification = await createNotification();
    const fake = provider({ ok: true, providerMessageId: "resend_abc" });

    const outcome = await sendNotification(
      { tenantId, notificationId: notification.id },
      options(fake),
    );

    expect(outcome).toBe("SENT");
    expect(fake.sent).toHaveLength(1);
    expect(fake.sent[0]?.to).toBe("owner@example.test");
    expect(fake.sent[0]?.html).toContain("http://localhost:3000/invitations/tok123");

    const settled = await prisma.notification.findUniqueOrThrow({
      where: { id: notification.id },
    });
    expect(settled.status).toBe("SENT");
    expect(settled.providerMessageId).toBe("resend_abc");
    expect(settled.sentAt).not.toBeNull();
  });

  it("clears the invitation link once the email is away", async () => {
    // The token exists nowhere else while it is queued; holding it after
    // delivery is exposure with no remaining purpose.
    const notification = await createNotification();

    await sendNotification(
      { tenantId, notificationId: notification.id },
      options(provider({ ok: true, providerMessageId: "x" })),
    );

    const settled = await prisma.notification.findUniqueOrThrow({
      where: { id: notification.id },
    });
    expect(JSON.stringify(settled.payload)).not.toContain("tok123");
  });

  it("claims exactly once when two workers race the same job", async () => {
    // BullMQ redelivers, and part 3's sweep will find PENDING rows too. Two
    // deliveries must not become two emails.
    const notification = await createNotification();
    const fake = provider({ ok: true, providerMessageId: "once" });

    const [first, second] = await Promise.all([
      sendNotification({ tenantId, notificationId: notification.id }, options(fake)),
      sendNotification({ tenantId, notificationId: notification.id }, options(fake)),
    ]);

    expect([first, second].filter((outcome) => outcome === "SENT")).toHaveLength(1);
    expect([first, second].filter((outcome) => outcome === "NOT_CLAIMED")).toHaveLength(1);
    expect(fake.sent).toHaveLength(1);
  });

  it("does not resend an already-sent notification", async () => {
    const notification = await createNotification({ status: "SENT", sentAt: new Date() });
    const fake = provider({ ok: true, providerMessageId: "y" });

    const outcome = await sendNotification(
      { tenantId, notificationId: notification.id },
      options(fake),
    );

    expect(outcome).toBe("NOT_CLAIMED");
    expect(fake.sent).toHaveLength(0);
  });

  describe("failures", () => {
    it("parks a permanent failure without retrying", async () => {
      // An invalid recipient will fail identically forever, and retrying it
      // asks the provider to keep delivering to a bad address — which is how a
      // sending domain earns a reputation problem.
      const notification = await createNotification();

      const outcome = await sendNotification(
        { tenantId, notificationId: notification.id },
        options(provider({ ok: false, code: "invalid_recipient", message: "bad address" })),
      );

      expect(outcome).toBe("FAILED");

      const settled = await prisma.notification.findUniqueOrThrow({
        where: { id: notification.id },
      });
      expect(settled.status).toBe("FAILED");
      expect(settled.lastError).toContain("invalid_recipient");
    });

    it("returns a transient failure to PENDING and rethrows for BullMQ", async () => {
      const notification = await createNotification();

      await expect(
        sendNotification(
          { tenantId, notificationId: notification.id },
          options(provider({ ok: false, statusCode: 503, message: "unavailable" })),
        ),
      ).rejects.toThrow(/notification send failed/u);

      const settled = await prisma.notification.findUniqueOrThrow({
        where: { id: notification.id },
      });
      // PENDING, not FAILED: both the queue's retry and the sweep must find it.
      expect(settled.status).toBe("PENDING");
      expect(settled.attempts).toBe(1);
    });

    it("gives up once attempts are exhausted", async () => {
      const notification = await createNotification({ attempts: 4 });

      const outcome = await sendNotification(
        { tenantId, notificationId: notification.id },
        options(provider({ ok: false, statusCode: 503, message: "unavailable" })),
      );

      expect(outcome).toBe("FAILED");
      const settled = await prisma.notification.findUniqueOrThrow({
        where: { id: notification.id },
      });
      expect(settled.status).toBe("FAILED");
      expect(settled.lastError).toContain("exhausted");
    });

    it("skips rather than fails when there is no template", async () => {
      // A booking confirmation has no renderer yet. That is a gap, not a
      // delivery failure, and must not fill the dead-letter queue.
      const notification = await createNotification({
        type: "BOOKING_CONFIRMATION",
        payload: {},
      });
      const fake = provider({ ok: true, providerMessageId: "z" });

      const outcome = await sendNotification(
        { tenantId, notificationId: notification.id },
        options(fake),
      );

      expect(outcome).toBe("SKIPPED");
      expect(fake.sent).toHaveLength(0);
    });

    it("skips when the payload is missing its link", async () => {
      const notification = await createNotification({ payload: { organizationName: "X" } });

      const outcome = await sendNotification(
        { tenantId, notificationId: notification.id },
        options(provider({ ok: true, providerMessageId: "z" })),
      );

      expect(outcome).toBe("SKIPPED");
    });
  });

  it("renders in the notification's own locale", async () => {
    const notification = await createNotification({ locale: "hu" });
    const fake = provider({ ok: true, providerMessageId: "hu" });

    await sendNotification({ tenantId, notificationId: notification.id }, options(fake));

    expect(fake.sent[0]?.subject).toContain("készen áll");
  });
});
