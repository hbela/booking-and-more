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

function provider(
  result: DeliveryResult,
  delivers = true,
): EmailProvider & { sent: EmailMessage[] } {
  const sent: EmailMessage[] = [];

  return {
    name: "fake",
    delivers,
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

  /**
   * The bug this flag was added for.
   *
   * The logging provider returns `ok: true`, so five real onboarding emails
   * were recorded SENT while Resend had never been called — an owner who never
   * received their invitation looked exactly like one who did, which is the
   * failure `requestPaymentLink` refuses to send inline to avoid, reintroduced
   * one layer down. `provider_message_id` was the only tell, and nobody reads a
   * null.
   */
  it("does not record SENT when the provider does not actually deliver", async () => {
    const notification = await createNotification();
    const logging = provider({ ok: true, providerMessageId: undefined }, false);

    const outcome = await sendNotification(
      { tenantId, notificationId: notification.id },
      options(logging),
    );

    expect(outcome).toBe("SKIPPED");
    // It was still handed to the provider — that is how the body reaches the
    // log, which is the whole purpose of running without a key.
    expect(logging.sent).toHaveLength(1);

    const settled = await prisma.notification.findUniqueOrThrow({
      where: { id: notification.id },
    });
    expect(settled.status).toBe("SKIPPED");
    expect(settled.sentAt).toBeNull();
    expect(settled.lastError).toContain("no email provider configured");
    // A terminal fallback has no delivery path that can use the token, so it is
    // cleared instead of becoming a long-lived bearer credential at rest.
    expect(settled.payload).toEqual({});
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

    it("counts the claim exactly once when deciding the attempt limit", async () => {
      const notification = await createNotification({ attempts: 3 });

      await expect(
        sendNotification(
          { tenantId, notificationId: notification.id },
          options(provider({ ok: false, statusCode: 503, message: "unavailable" })),
        ),
      ).rejects.toThrow(/notification send failed/u);

      await expect(
        prisma.notification.findUniqueOrThrow({ where: { id: notification.id } }),
      ).resolves.toMatchObject({ status: "PENDING", attempts: 4 });
    });

    it("skips rather than fails when there is no template", async () => {
      // A calendar disconnection has no renderer until Epic 6. That is a gap,
      // not a delivery failure, and must not fill the dead-letter queue.
      const notification = await createNotification({
        type: "CALENDAR_DISCONNECTED",
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

  describe("PROVIDER_INVITED", () => {
    const invitation = (overrides: Record<string, unknown> = {}) =>
      createNotification({
        type: "PROVIDER_INVITED",
        template: "provider-invited",
        recipient: "anna@example.test",
        dedupeKey: `v1:PROVIDER_INVITED:EMAIL:${Math.random().toString(36).slice(2)}`,
        payload: {
          organizationName: "Wellness Kft",
          providerName: "Dr. Kovács Anna",
          invitedByName: "Nagy Béla",
          acceptUrl: "http://localhost:3000/en/invitations/tok456",
          expiresAt: new Date().toISOString(),
        },
        ...overrides,
      });

    it("sends the link and then wipes it", async () => {
      const notification = await invitation();
      const fake = provider({ ok: true, providerMessageId: "resend_prov" });

      const outcome = await sendNotification(
        { tenantId, notificationId: notification.id },
        options(fake),
      );

      expect(outcome).toBe("SENT");
      expect(fake.sent[0]?.to).toBe("anna@example.test");
      expect(fake.sent[0]?.html).toContain("http://localhost:3000/en/invitations/tok456");

      const settled = await prisma.notification.findUniqueOrThrow({
        where: { id: notification.id },
      });
      // The token's exposure is bounded to the moment it is needed.
      expect(settled.payload).toEqual({});
    });

    it("greets the recipient by address when the payload names nobody", async () => {
      const notification = await invitation({
        payload: {
          organizationName: "Wellness Kft",
          acceptUrl: "http://localhost:3000/invitations/tok456",
        },
      });
      const fake = provider({ ok: true, providerMessageId: "x" });

      await sendNotification({ tenantId, notificationId: notification.id }, options(fake));

      // Their own address beats their employer's name, and beats a blank.
      expect(fake.sent[0]?.text).toContain("anna@example.test");
      expect(fake.sent[0]?.text).toContain("Wellness Kft");
    });

    it("skips rather than sends an email with no link", async () => {
      const notification = await invitation({ payload: { organizationName: "Wellness Kft" } });

      const outcome = await sendNotification(
        { tenantId, notificationId: notification.id },
        options(provider({ ok: true, providerMessageId: "z" })),
      );

      expect(outcome).toBe("SKIPPED");
    });

    it("clears the payload when the provider cannot deliver", async () => {
      // phase-9-owner-onboarding-emails §2: when nothing was sent, the token in
      // that column is the only copy anyone has. Clearing it here would destroy
      // the one route back to a stuck invitee.
      const notification = await invitation();
      const fake = provider({ ok: true, providerMessageId: "n/a" }, false);

      const outcome = await sendNotification(
        { tenantId, notificationId: notification.id },
        options(fake),
      );

      // The provider *is* called — the logging one writes it to the log — and
      // it accepts. What must not happen is the accept being recorded as SENT.
      expect(outcome).toBe("SKIPPED");
      expect(fake.sent).toHaveLength(1);

      const settled = await prisma.notification.findUniqueOrThrow({
        where: { id: notification.id },
      });
      expect(settled.status).toBe("SKIPPED");
      expect(settled.providerMessageId).toBeNull();
      expect(settled.payload).toEqual({});
    });
  });

  /**
   * The booking emails, which take the other path through the sender.
   *
   * Everything an onboarding email carries in its payload, these re-read from
   * the booking — so the interesting assertions are about a booking that has
   * changed since the notification row was written
   * (docs/phase-5-booking-notifications.md §2.3).
   */
  describe("booking emails", () => {
    const MANAGE_URL = "http://localhost:3000/en/booking/manage/tok789";

    async function bookingFixture(overrides: { status?: string; language?: string } = {}) {
      const unique = Math.random().toString(36).slice(2, 8);

      const provider_ = await prisma.provider.create({
        data: { tenantId, displayName: "Dr. Kiss Anna", timezone: "Europe/Budapest" },
      });
      const service = await prisma.service.create({
        data: { tenantId, slug: `cleaning-${unique}`, name: "Fogtisztítás", durationMinutes: 30 },
      });
      const customer = await prisma.customer.create({
        data: {
          tenantId,
          fullName: "Nagy Béla",
          email: `patient-${unique}@example.test`,
          preferredLanguage: overrides.language ?? "en",
        },
      });

      const cancelled = overrides.status === "CANCELLED";

      return prisma.booking.create({
        data: {
          tenantId,
          reference: `BK-${unique.toUpperCase()}`,
          customerId: customer.id,
          providerId: provider_.id,
          serviceId: service.id,
          startAt: new Date("2026-09-10T08:00:00.000Z"),
          endAt: new Date("2026-09-10T08:30:00.000Z"),
          ...(overrides.status === undefined ? {} : { status: overrides.status as "CONFIRMED" }),
          // The CHECK constraint refuses a cancelled booking that does not say
          // when — phase-4 §3.2.
          ...(cancelled ? { cancelledAt: new Date() } : {}),
          customerNameSnapshot: "Nagy Béla",
          customerEmailSnapshot: `patient-${unique}@example.test`,
          serviceNameSnapshot: "Fogtisztítás",
          priceMinorSnapshot: 15_000,
          currencySnapshot: "HUF",
        },
      });
    }

    const bookingNotification = (bookingId: string, overrides: Record<string, unknown> = {}) =>
      createNotification({
        type: "BOOKING_CONFIRMATION",
        template: "booking-confirmation",
        recipient: "patient@example.test",
        bookingId,
        dedupeKey: `v1:BOOKING:EMAIL:${Math.random().toString(36).slice(2)}`,
        payload: { manageUrl: MANAGE_URL },
        ...overrides,
      });

    it("renders from the booking rather than from the payload", async () => {
      const booking = await bookingFixture();
      const notification = await bookingNotification(booking.id);
      const fake = provider({ ok: true, providerMessageId: "bkg" });

      const outcome = await sendNotification(
        { tenantId, notificationId: notification.id },
        options(fake),
      );

      expect(outcome).toBe("SENT");
      expect(fake.sent[0]?.text).toContain("Dr. Kiss Anna");
      expect(fake.sent[0]?.text).toContain("Fogtisztítás");
      expect(fake.sent[0]?.text).toContain(booking.reference);
      expect(fake.sent[0]?.html).toContain(MANAGE_URL);
    });

    it("formats the appointment in the clinic's zone, not the server's", async () => {
      // 08:00 UTC in September is 10:00 in Budapest. A customer reading UTC
      // turns up two hours early, which is the bug this asserts against.
      const booking = await bookingFixture();
      const notification = await bookingNotification(booking.id);
      const fake = provider({ ok: true, providerMessageId: "tz" });

      await sendNotification({ tenantId, notificationId: notification.id }, options(fake));

      expect(fake.sent[0]?.text).toContain("10:00");
    });

    it("offers a calendar link stamped in UTC, not in the clinic's zone", async () => {
      // The counterpart to the test above, and the reason the two disagree: the
      // printed time is 10:00 because the clinic is in Budapest, while the
      // calendar event is the instant, so a customer abroad sees their own
      // local time on their own phone (calendar.ts).
      const booking = await bookingFixture();
      const notification = await bookingNotification(booking.id);
      const fake = provider({ ok: true, providerMessageId: "cal" });

      await sendNotification({ tenantId, notificationId: notification.id }, options(fake));

      expect(fake.sent[0]?.text).toContain("calendar.google.com/calendar/render");
      expect(fake.sent[0]?.text).toContain("dates=20260910T080000Z%2F20260910T083000Z");
      // The href survives escaping with its separators intact — an `&` left
      // raw in HTML is a URL Google reads as one parameter.
      expect(fake.sent[0]?.html).toContain("&amp;dates=");
    });

    it("clears the manage link once the email is away", async () => {
      const booking = await bookingFixture();
      const notification = await bookingNotification(booking.id);

      await sendNotification(
        { tenantId, notificationId: notification.id },
        options(provider({ ok: true, providerMessageId: "clear" })),
      );

      const settled = await prisma.notification.findUniqueOrThrow({
        where: { id: notification.id },
      });
      expect(JSON.stringify(settled.payload)).not.toContain("tok789");
    });

    it("skips a reminder for a booking cancelled since it was planned", async () => {
      // The case the send-time re-check exists for. The row was written when the
      // booking was made; a great deal can happen in the day before it sends.
      const booking = await bookingFixture({ status: "CANCELLED" });
      const notification = await bookingNotification(booking.id, {
        type: "BOOKING_REMINDER",
        template: "booking-reminder",
        payload: {},
      });
      const fake = provider({ ok: true, providerMessageId: "never" });

      const outcome = await sendNotification(
        { tenantId, notificationId: notification.id },
        options(fake),
      );

      expect(outcome).toBe("SKIPPED");
      expect(fake.sent).toHaveLength(0);

      const settled = await prisma.notification.findUniqueOrThrow({
        where: { id: notification.id },
      });
      // SKIPPED, not FAILED: retrying cannot make a cancelled booking live.
      expect(settled.status).toBe("SKIPPED");
      expect(settled.lastError).toContain("BOOKING_NOT_LIVE");
    });

    it("skips a cancellation notice for a booking that is not cancelled", async () => {
      const booking = await bookingFixture();
      const notification = await bookingNotification(booking.id, {
        type: "BOOKING_CANCELLED",
        template: "booking-cancelled",
        payload: {},
      });

      const outcome = await sendNotification(
        { tenantId, notificationId: notification.id },
        options(provider({ ok: true, providerMessageId: "no" })),
      );

      expect(outcome).toBe("SKIPPED");
    });

    it("skips when the booking has gone rather than burning the attempt budget", async () => {
      const booking = await bookingFixture();
      const notification = await bookingNotification(booking.id);
      await prisma.booking.delete({ where: { id: booking.id } });

      const outcome = await sendNotification(
        { tenantId, notificationId: notification.id },
        options(provider({ ok: true, providerMessageId: "gone" })),
      );

      expect(outcome).toBe("SKIPPED");
    });

    it("renders in the notification's locale", async () => {
      const booking = await bookingFixture();
      const notification = await bookingNotification(booking.id, { locale: "hu" });
      const fake = provider({ ok: true, providerMessageId: "hu" });

      await sendNotification({ tenantId, notificationId: notification.id }, options(fake));

      expect(fake.sent[0]?.subject).toContain("visszaigazolva");
    });

    it("sends a confirmation with no button when staff accepted the request", async () => {
      // That path holds no raw token, so the template points back at the email
      // the customer already has rather than at a link that does not exist.
      const booking = await bookingFixture();
      const notification = await bookingNotification(booking.id, { payload: {} });
      const fake = provider({ ok: true, providerMessageId: "accepted" });

      const outcome = await sendNotification(
        { tenantId, notificationId: notification.id },
        options(fake),
      );

      expect(outcome).toBe("SENT");
      expect(fake.sent[0]?.text).toContain("the email you received when you booked");
    });
  });
});
