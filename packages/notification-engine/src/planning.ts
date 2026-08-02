import { buildDedupeKey } from "./dedupe.js";
import { resolveLocale } from "./locale.js";
import {
  NotificationChannels,
  NotificationTypes,
  type Locale,
  type NotificationChannel,
  type NotificationType,
} from "./types.js";

/**
 * What an outbox event owes people. tech-impl §12, §26.2, §27.
 *
 * The dispatcher reads a row and asks this module what should be sent. Nothing
 * here sends anything, reads a database, or knows what a queue is — it turns
 * facts about a booking into a list of messages that ought to exist, which is
 * the part with all the rules in it and none of the I/O.
 *
 * The facts arrive as values rather than as a Prisma row for the usual reason
 * (CLAUDE.md rule 8), and one less usual one: the dispatcher re-reads the
 * booking when the job runs, so what this function sees is the booking *now*,
 * not as it was when the event was written. A confirmation event redelivered
 * after a cancellation must not send a confirmation, and that is decidable only
 * from current facts.
 */

/** Event types written by the API. Unrecognised values are ignored, not errors. */
export const OutboxEventTypes = {
  BOOKING_CONFIRMED: "BOOKING_CONFIRMED",
  BOOKING_RESCHEDULED: "BOOKING_RESCHEDULED",
  BOOKING_CANCELLED: "BOOKING_CANCELLED",
} as const;

export type OutboxEventType = (typeof OutboxEventTypes)[keyof typeof OutboxEventTypes];

/** Statuses for which a forward-looking message (confirmation, reminder) makes sense. */
const LIVE_BOOKING_STATUSES = new Set(["PENDING", "CONFIRMED"]);

export interface BookingNotificationFacts {
  bookingId: string;
  /** `Booking.version` — the optimistic-locking counter every write bumps. */
  bookingVersion: number;
  /** Current `BookingStatus`, as read now rather than when the event was written. */
  bookingStatus: string;
  /** The appointment start, ISO-8601. */
  startAtIso: string;
  customerId?: string | null;
  /** `Booking.customerEmailSnapshot` — what the customer was actually told. */
  recipientEmail?: string | null;
  /** `Customer.preferredLanguage`. */
  customerLanguage?: string | null;
  /** `Tenant.defaultLanguage`. */
  tenantLanguage?: string | null;
}

export interface NotificationPlan {
  type: NotificationType;
  channel: NotificationChannel;
  /** Template identifier; the renderer pairs it with `locale`. */
  template: string;
  locale: Locale;
  recipient: string;
  /** When it should go out, ISO-8601. Now, for everything but reminders. */
  scheduledAtIso: string;
  dedupeKey: string;
  bookingId: string;
  customerId: string | null;
}

export const SkipReasons = {
  /** Booked over the phone with no email address. Correct, not a failure. */
  NO_RECIPIENT: "NO_RECIPIENT",
  /** The booking has moved on — cancelled, completed, expired. */
  BOOKING_NOT_LIVE: "BOOKING_NOT_LIVE",
  /** Booked closer to the appointment than the reminder lead time. */
  REMINDER_LEAD_TIME_PASSED: "REMINDER_LEAD_TIME_PASSED",
  /** A cancellation notice for a booking that is not cancelled. */
  BOOKING_NOT_CANCELLED: "BOOKING_NOT_CANCELLED",
} as const;

export type SkipReason = (typeof SkipReasons)[keyof typeof SkipReasons];

export interface SkippedNotification {
  type: NotificationType;
  reason: SkipReason;
}

export interface NotificationPlanResult {
  /**
   * Whether the event type is one this engine knows. `false` is not an error:
   * the outbox carries events for calendar sync and usage aggregation too, and
   * a dispatcher that treated every unknown type as a failure would retry them
   * forever.
   */
  recognised: boolean;
  plans: NotificationPlan[];
  /** Messages deliberately not planned, and why. Worth logging; not a failure. */
  skipped: SkippedNotification[];
}

export interface PlanNotificationsInput {
  eventType: string;
  facts: BookingNotificationFacts;
  /** Evaluation time, injected rather than read from the clock so this stays pure. */
  now: Date;
  /** How far ahead of the appointment a reminder goes out. */
  reminderLeadHours: number;
  /** Restricted to EMAIL in Epic 5; SMS and push are later epics. */
  channel?: NotificationChannel;
}

const TEMPLATES: Record<NotificationType, string> = {
  [NotificationTypes.BOOKING_CONFIRMATION]: "booking-confirmation",
  [NotificationTypes.BOOKING_UPDATED]: "booking-updated",
  [NotificationTypes.BOOKING_CANCELLED]: "booking-cancelled",
  [NotificationTypes.BOOKING_REMINDER]: "booking-reminder",
  [NotificationTypes.CALENDAR_DISCONNECTED]: "calendar-disconnected",
  // Not planned from a booking event — provisioning writes it directly — but
  // listed so the table stays exhaustive and adding a type keeps failing here
  // until it has a template name.
  [NotificationTypes.ORGANIZATION_CREATED]: "organization-created",
  // Likewise not planned from a booking: billing writes it directly.
  [NotificationTypes.SUBSCRIPTION_LINK]: "subscription-link",
  // Nor these two — the worker writes them when Stripe says a trial is ending
  // or a renewal was declined (phase-9-subscription-lifecycle.md §2.1, §2.3).
  [NotificationTypes.TRIAL_ENDING_SOON]: "trial-ending",
  [NotificationTypes.SUBSCRIPTION_PAYMENT_FAILED]: "payment-failed",
  // Written by the Stripe processor when a subscription first reports a live
  // status, not planned from a booking either.
  [NotificationTypes.SUBSCRIPTION_CONFIRMED]: "subscription-confirmed",
};

export function planNotifications(input: PlanNotificationsInput): NotificationPlanResult {
  const channel = input.channel ?? NotificationChannels.EMAIL;

  switch (input.eventType) {
    case OutboxEventTypes.BOOKING_CONFIRMED:
      // A confirmation and the reminder that follows it are planned together:
      // the moment a booking exists is the moment both are owed, and planning
      // the reminder here means no separate scheduling pass can forget it.
      return combine(
        planImmediate(NotificationTypes.BOOKING_CONFIRMATION, input, channel),
        planReminder(input, channel),
      );

    case OutboxEventTypes.BOOKING_RESCHEDULED:
      // The reminder is re-planned because its dedupe key includes the new
      // start time, so this produces a genuinely new row rather than colliding
      // with the reminder for the old one.
      return combine(
        planImmediate(NotificationTypes.BOOKING_UPDATED, input, channel),
        planReminder(input, channel),
      );

    case OutboxEventTypes.BOOKING_CANCELLED:
      return planCancellation(input, channel);

    default:
      return { recognised: false, plans: [], skipped: [] };
  }
}

function planImmediate(
  type: typeof NotificationTypes.BOOKING_CONFIRMATION | typeof NotificationTypes.BOOKING_UPDATED,
  input: PlanNotificationsInput,
  channel: NotificationChannel,
): NotificationPlanResult {
  const { facts } = input;

  if (!LIVE_BOOKING_STATUSES.has(facts.bookingStatus)) {
    return skip(type, SkipReasons.BOOKING_NOT_LIVE);
  }

  const recipient = usableRecipient(facts);
  if (recipient === undefined) return skip(type, SkipReasons.NO_RECIPIENT);

  const dedupeKey =
    type === NotificationTypes.BOOKING_CONFIRMATION
      ? buildDedupeKey({ type, channel, bookingId: facts.bookingId })
      : buildDedupeKey({
          type,
          channel,
          bookingId: facts.bookingId,
          bookingVersion: facts.bookingVersion,
        });

  return {
    recognised: true,
    skipped: [],
    plans: [
      {
        type,
        channel,
        template: TEMPLATES[type],
        locale: localeFor(facts),
        recipient,
        scheduledAtIso: input.now.toISOString(),
        dedupeKey,
        bookingId: facts.bookingId,
        customerId: facts.customerId ?? null,
      },
    ],
  };
}

function planReminder(
  input: PlanNotificationsInput,
  channel: NotificationChannel,
): NotificationPlanResult {
  const type = NotificationTypes.BOOKING_REMINDER;
  const { facts } = input;

  if (!LIVE_BOOKING_STATUSES.has(facts.bookingStatus)) {
    return skip(type, SkipReasons.BOOKING_NOT_LIVE);
  }

  const recipient = usableRecipient(facts);
  if (recipient === undefined) return skip(type, SkipReasons.NO_RECIPIENT);

  const startMillis = Date.parse(facts.startAtIso);
  if (Number.isNaN(startMillis)) {
    throw new Error(
      `startAtIso must be a parseable ISO-8601 instant: received ${JSON.stringify(facts.startAtIso)}`,
    );
  }

  const sendAtMillis = startMillis - input.reminderLeadHours * 60 * 60 * 1_000;

  // Someone booking tomorrow morning at 23:00 tonight is inside a 24-hour lead
  // time. Sending the reminder immediately would be a second confirmation, so
  // there is simply no reminder — the customer just booked, they know.
  if (sendAtMillis <= input.now.getTime()) {
    return skip(type, SkipReasons.REMINDER_LEAD_TIME_PASSED);
  }

  return {
    recognised: true,
    skipped: [],
    plans: [
      {
        type,
        channel,
        template: TEMPLATES[type],
        locale: localeFor(facts),
        recipient,
        scheduledAtIso: new Date(sendAtMillis).toISOString(),
        dedupeKey: buildDedupeKey({
          type,
          channel,
          bookingId: facts.bookingId,
          startAtIso: facts.startAtIso,
        }),
        bookingId: facts.bookingId,
        customerId: facts.customerId ?? null,
      },
    ],
  };
}

function planCancellation(
  input: PlanNotificationsInput,
  channel: NotificationChannel,
): NotificationPlanResult {
  const type = NotificationTypes.BOOKING_CANCELLED;
  const { facts } = input;

  // Guards against a stale event: if the booking is live again — rebooked,
  // reinstated — telling the customer it was cancelled is worse than silence.
  if (facts.bookingStatus !== "CANCELLED") {
    return skip(type, SkipReasons.BOOKING_NOT_CANCELLED);
  }

  const recipient = usableRecipient(facts);
  if (recipient === undefined) return skip(type, SkipReasons.NO_RECIPIENT);

  return {
    recognised: true,
    skipped: [],
    plans: [
      {
        type,
        channel,
        template: TEMPLATES[type],
        locale: localeFor(facts),
        recipient,
        scheduledAtIso: input.now.toISOString(),
        dedupeKey: buildDedupeKey({ type, channel, bookingId: facts.bookingId }),
        bookingId: facts.bookingId,
        customerId: facts.customerId ?? null,
      },
    ],
  };
}

/**
 * Trimmed, or undefined.
 *
 * No format validation: the address came from the booking form, which validated
 * it, and a second opinion here would only disagree in the cases where RFC 5322
 * is stranger than people expect. An address the provider rejects is a
 * PERMANENT failure, classified in retry.ts, and that is the right place for it.
 */
function usableRecipient(facts: BookingNotificationFacts): string | undefined {
  const email = facts.recipientEmail?.trim();
  return email === undefined || email === "" ? undefined : email;
}

function localeFor(facts: BookingNotificationFacts): Locale {
  return resolveLocale({
    customerLanguage: facts.customerLanguage,
    tenantLanguage: facts.tenantLanguage,
  });
}

function skip(type: NotificationType, reason: SkipReason): NotificationPlanResult {
  return { recognised: true, plans: [], skipped: [{ type, reason }] };
}

function combine(...results: NotificationPlanResult[]): NotificationPlanResult {
  return {
    recognised: true,
    plans: results.flatMap((result) => result.plans),
    skipped: results.flatMap((result) => result.skipped),
  };
}
