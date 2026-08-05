import { describe, expect, it } from "vitest";

import {
  checkStillOwed,
  OutboxEventTypes,
  planNotifications,
  SkipReasons,
  type BookingNotificationFacts,
  type PlanNotificationsInput,
} from "./planning.js";
import { NotificationTypes } from "./types.js";

const NOW = new Date("2026-08-01T08:00:00.000Z");

function facts(overrides: Partial<BookingNotificationFacts> = {}): BookingNotificationFacts {
  return {
    bookingId: "bkg_1",
    bookingVersion: 0,
    bookingStatus: "CONFIRMED",
    startAtIso: "2026-08-05T09:00:00.000Z",
    customerId: "cus_1",
    recipientEmail: "patient@example.com",
    customerLanguage: "hu",
    tenantLanguage: "hu",
    ...overrides,
  };
}

function plan(overrides: Partial<PlanNotificationsInput> = {}) {
  return planNotifications({
    eventType: OutboxEventTypes.BOOKING_CONFIRMED,
    facts: facts(),
    now: NOW,
    reminderLeadHours: 24,
    ...overrides,
  });
}

describe("planNotifications", () => {
  describe("unrecognised events", () => {
    it("reports them rather than treating them as failures", () => {
      // The outbox also carries calendar-sync and usage events. A dispatcher
      // that failed on them would retry them forever.
      const result = plan({ eventType: "CALENDAR_SYNC_REQUESTED" });

      expect(result.recognised).toBe(false);
      expect(result.plans).toHaveLength(0);
      expect(result.skipped).toHaveLength(0);
    });
  });

  describe("BOOKING_CONFIRMED", () => {
    it("plans the confirmation and the reminder together", () => {
      // Both are owed the moment the booking exists; planning them together
      // means no separate scheduling pass can forget the reminder.
      const result = plan();

      expect(result.plans.map((entry) => entry.type)).toEqual([
        NotificationTypes.BOOKING_CONFIRMATION,
        NotificationTypes.BOOKING_REMINDER,
      ]);
    });

    it("sends the confirmation now and the reminder at the lead time", () => {
      const result = plan();
      const [confirmation, reminder] = result.plans;

      expect(confirmation?.scheduledAtIso).toBe(NOW.toISOString());
      // 24 hours before 2026-08-05T09:00Z.
      expect(reminder?.scheduledAtIso).toBe("2026-08-04T09:00:00.000Z");
    });

    it("carries the booking and customer through to each plan", () => {
      const result = plan();

      for (const entry of result.plans) {
        expect(entry.bookingId).toBe("bkg_1");
        expect(entry.customerId).toBe("cus_1");
        expect(entry.recipient).toBe("patient@example.com");
      }
    });

    it("gives every plan a distinct dedupe key", () => {
      const result = plan();
      const keys = new Set(result.plans.map((entry) => entry.dedupeKey));

      expect(keys.size).toBe(result.plans.length);
    });

    it("skips both when there is no email address", () => {
      // A booking taken over the phone. Correct, not a failure — which is why
      // these are `skipped` rather than an error the dispatcher would retry.
      const result = plan({ facts: facts({ recipientEmail: null }) });

      expect(result.plans).toHaveLength(0);
      expect(result.skipped).toEqual([
        { type: NotificationTypes.BOOKING_CONFIRMATION, reason: SkipReasons.NO_RECIPIENT },
        { type: NotificationTypes.BOOKING_REMINDER, reason: SkipReasons.NO_RECIPIENT },
      ]);
    });

    it("treats a blank email as absent", () => {
      const result = plan({ facts: facts({ recipientEmail: "   " }) });
      expect(result.plans).toHaveLength(0);
    });

    it("sends no confirmation for a booking that has since been cancelled", () => {
      // The dispatcher re-reads the booking, so a redelivered event sees the
      // world as it is now. Confirming a cancelled booking is worse than
      // silence.
      const result = plan({ facts: facts({ bookingStatus: "CANCELLED" }) });

      expect(result.plans).toHaveLength(0);
      expect(result.skipped.map((entry) => entry.reason)).toEqual([
        SkipReasons.BOOKING_NOT_LIVE,
        SkipReasons.BOOKING_NOT_LIVE,
      ]);
    });

    it("still notifies a PENDING booking awaiting approval", () => {
      const result = plan({ facts: facts({ bookingStatus: "PENDING" }) });
      expect(result.plans.length).toBeGreaterThan(0);
    });

    describe("when the appointment is inside the reminder lead time", () => {
      it("plans the confirmation but no reminder", () => {
        // Booked at 08:00 for 09:00 the same day, with a 24-hour lead. Sending
        // the reminder immediately would just be a second confirmation.
        const result = plan({
          facts: facts({ startAtIso: "2026-08-01T09:00:00.000Z" }),
        });

        expect(result.plans.map((entry) => entry.type)).toEqual([
          NotificationTypes.BOOKING_CONFIRMATION,
        ]);
        expect(result.skipped).toEqual([
          {
            type: NotificationTypes.BOOKING_REMINDER,
            reason: SkipReasons.REMINDER_LEAD_TIME_PASSED,
          },
        ]);
      });

      it("treats a reminder due exactly now as passed", () => {
        const result = plan({
          facts: facts({ startAtIso: "2026-08-02T08:00:00.000Z" }),
          reminderLeadHours: 24,
        });

        expect(result.skipped.map((entry) => entry.reason)).toContain(
          SkipReasons.REMINDER_LEAD_TIME_PASSED,
        );
      });
    });
  });

  describe("BOOKING_RESCHEDULED", () => {
    it("plans an update and a fresh reminder", () => {
      const result = plan({ eventType: OutboxEventTypes.BOOKING_RESCHEDULED });

      expect(result.plans.map((entry) => entry.type)).toEqual([
        NotificationTypes.BOOKING_UPDATED,
        NotificationTypes.BOOKING_REMINDER,
      ]);
    });

    it("keys the reminder on the new start time, so it does not collide with the old one", () => {
      const before = planNotifications({
        eventType: OutboxEventTypes.BOOKING_CONFIRMED,
        facts: facts({ startAtIso: "2026-08-05T09:00:00.000Z" }),
        now: NOW,
        reminderLeadHours: 24,
      });
      const after = planNotifications({
        eventType: OutboxEventTypes.BOOKING_RESCHEDULED,
        facts: facts({ startAtIso: "2026-08-06T09:00:00.000Z", bookingVersion: 1 }),
        now: NOW,
        reminderLeadHours: 24,
      });

      const reminderBefore = before.plans.find(
        (entry) => entry.type === NotificationTypes.BOOKING_REMINDER,
      );
      const reminderAfter = after.plans.find(
        (entry) => entry.type === NotificationTypes.BOOKING_REMINDER,
      );

      expect(reminderBefore?.dedupeKey).not.toBe(reminderAfter?.dedupeKey);
    });

    it("gives each reschedule its own update key", () => {
      const first = planNotifications({
        eventType: OutboxEventTypes.BOOKING_RESCHEDULED,
        facts: facts({ bookingVersion: 1 }),
        now: NOW,
        reminderLeadHours: 24,
      });
      const second = planNotifications({
        eventType: OutboxEventTypes.BOOKING_RESCHEDULED,
        facts: facts({ bookingVersion: 2 }),
        now: NOW,
        reminderLeadHours: 24,
      });

      const keyOf = (result: typeof first) =>
        result.plans.find((entry) => entry.type === NotificationTypes.BOOKING_UPDATED)?.dedupeKey;

      expect(keyOf(first)).not.toBe(keyOf(second));
    });
  });

  describe("BOOKING_CANCELLED", () => {
    it("plans a cancellation notice and nothing else", () => {
      const result = plan({
        eventType: OutboxEventTypes.BOOKING_CANCELLED,
        facts: facts({ bookingStatus: "CANCELLED" }),
      });

      expect(result.plans.map((entry) => entry.type)).toEqual([
        NotificationTypes.BOOKING_CANCELLED,
      ]);
    });

    it("does not tell a customer their live booking was cancelled", () => {
      // A stale event for a booking that has since been reinstated.
      const result = plan({
        eventType: OutboxEventTypes.BOOKING_CANCELLED,
        facts: facts({ bookingStatus: "CONFIRMED" }),
      });

      expect(result.plans).toHaveLength(0);
      expect(result.skipped).toEqual([
        { type: NotificationTypes.BOOKING_CANCELLED, reason: SkipReasons.BOOKING_NOT_CANCELLED },
      ]);
    });

    it("plans no new reminder", () => {
      const result = plan({
        eventType: OutboxEventTypes.BOOKING_CANCELLED,
        facts: facts({ bookingStatus: "CANCELLED" }),
      });

      expect(result.plans.some((entry) => entry.type === NotificationTypes.BOOKING_REMINDER)).toBe(
        false,
      );
    });
  });

  describe("locale", () => {
    it("uses the customer's language over the tenant's", () => {
      const result = plan({
        facts: facts({ customerLanguage: "en", tenantLanguage: "hu" }),
      });

      expect(result.plans[0]?.locale).toBe("en");
    });

    it("falls back to the tenant's when the customer has none", () => {
      const result = plan({
        facts: facts({ customerLanguage: null, tenantLanguage: "en" }),
      });

      expect(result.plans[0]?.locale).toBe("en");
    });
  });

  describe("determinism", () => {
    it("plans identically for identical input", () => {
      // The property the whole dedupe scheme rests on: a redelivered event
      // produces byte-identical keys, so the unique index catches it.
      const first = plan();
      const second = plan();

      expect(first.plans.map((entry) => entry.dedupeKey)).toEqual(
        second.plans.map((entry) => entry.dedupeKey),
      );
    });
  });
});

describe("BOOKING_REQUESTED", () => {
  it("plans the request email and nothing else", () => {
    const result = plan({
      eventType: OutboxEventTypes.BOOKING_REQUESTED,
      facts: facts({ bookingStatus: "PENDING" }),
    });

    expect(result.recognised).toBe(true);
    expect(result.plans.map((entry) => entry.type)).toEqual([NotificationTypes.BOOKING_REQUESTED]);
  });

  it("plans no reminder", () => {
    // A request is not an appointment yet. Reminding somebody about a booking
    // nobody has accepted is worse than silence — the reminder is planned by
    // the BOOKING_CONFIRMED event acceptance writes
    // (docs/phase-5-booking-notifications.md §2.4).
    const result = plan({
      eventType: OutboxEventTypes.BOOKING_REQUESTED,
      facts: facts({ bookingStatus: "PENDING" }),
    });

    expect(result.plans.map((entry) => entry.type)).not.toContain(
      NotificationTypes.BOOKING_REMINDER,
    );
  });

  it("keys separately from the confirmation that follows it", () => {
    // Sharing BOOKING_CONFIRMATION's one-per-booking key would send the request
    // and silently swallow the acceptance.
    const requested = plan({
      eventType: OutboxEventTypes.BOOKING_REQUESTED,
      facts: facts({ bookingStatus: "PENDING" }),
    });
    const confirmed = plan({ eventType: OutboxEventTypes.BOOKING_CONFIRMED });

    expect(requested.plans[0]?.dedupeKey).not.toBe(confirmed.plans[0]?.dedupeKey);
  });

  it("still skips a booking with no way to reach the customer", () => {
    const result = plan({
      eventType: OutboxEventTypes.BOOKING_REQUESTED,
      facts: facts({ bookingStatus: "PENDING", recipientEmail: null }),
    });

    expect(result.plans).toHaveLength(0);
    expect(result.skipped[0]?.reason).toBe(SkipReasons.NO_RECIPIENT);
  });
});

describe("checkStillOwed", () => {
  const forwardLooking = [
    NotificationTypes.BOOKING_CONFIRMATION,
    NotificationTypes.BOOKING_REQUESTED,
    NotificationTypes.BOOKING_UPDATED,
    NotificationTypes.BOOKING_REMINDER,
  ] as const;

  it.each(forwardLooking)("owes %s while the booking is live", (type) => {
    expect(checkStillOwed({ type, bookingStatus: "CONFIRMED" })).toEqual({ owed: true });
    expect(checkStillOwed({ type, bookingStatus: "PENDING" })).toEqual({ owed: true });
  });

  it.each(forwardLooking)("stops owing %s once the booking is cancelled", (type) => {
    // The case the whole function exists for: a reminder is planned when the
    // booking is made and sent a day before the appointment, and a booking
    // cancelled overnight owes nobody a reminder.
    expect(checkStillOwed({ type, bookingStatus: "CANCELLED" })).toEqual({
      owed: false,
      reason: SkipReasons.BOOKING_NOT_LIVE,
    });
  });

  it("owes a cancellation notice only for a cancelled booking", () => {
    expect(
      checkStillOwed({ type: NotificationTypes.BOOKING_CANCELLED, bookingStatus: "CANCELLED" }),
    ).toEqual({ owed: true });

    // Rebooked or reinstated: telling the customer it was cancelled is worse
    // than saying nothing.
    expect(
      checkStillOwed({ type: NotificationTypes.BOOKING_CANCELLED, bookingStatus: "CONFIRMED" }),
    ).toEqual({ owed: false, reason: SkipReasons.BOOKING_NOT_CANCELLED });
  });

  it("agrees with planNotifications about what live means", () => {
    // Both read LIVE_BOOKING_STATUSES. If they ever disagree, a message is
    // planned that can never be sent, or sent that should never have been.
    const planned = plan({ facts: facts({ bookingStatus: "COMPLETED" }) });

    expect(planned.plans).toHaveLength(0);
    expect(
      checkStillOwed({ type: NotificationTypes.BOOKING_CONFIRMATION, bookingStatus: "COMPLETED" })
        .owed,
    ).toBe(false);
  });
});
