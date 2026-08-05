import { NotificationTypes, type NotificationChannel, type NotificationType } from "./types.js";

/**
 * "This message, about this thing, once."
 *
 * Epic 5's third exit criterion is that duplicate events do not send duplicate
 * messages, and the unique index on `notifications(tenant_id, dedupe_key)` is
 * what enforces it. This module decides what goes into that key, which is the
 * whole of the interesting part: too coarse and a legitimate second message is
 * swallowed, too fine and a redelivered event sends twice.
 *
 * There are three sources of duplication to survive, and they are different:
 *
 *   1. The outbox dispatcher claims a row, publishes, and dies before marking
 *      it processed. The row is re-claimed and re-published.
 *   2. BullMQ retries a job whose failure happened after the send.
 *   3. Two API requests genuinely write two outbox events for one action.
 *
 * All three produce the same key and collapse to one row. What must *not*
 * collapse is a booking rescheduled twice, or a reminder for a booking that
 * moved — those are different messages that happen to share a booking id, and
 * each type below says explicitly what distinguishes them.
 */

/**
 * Prefix so a future change to the key scheme cannot collide with keys already
 * in the table. Bumping it re-sends rather than silently suppresses, which is
 * the right way round for a mistake to fail.
 */
const SCHEME = "v1";

const SEPARATOR = ":";

export type DedupeInput =
  /** One confirmation per booking, forever. Re-confirming is not a thing. */
  | {
      type: typeof NotificationTypes.BOOKING_CONFIRMATION;
      channel: NotificationChannel;
      bookingId: string;
    }
  /**
   * Keyed on the booking's optimistic-locking counter, which every write bumps.
   * A booking rescheduled twice owes the customer two emails, and they differ
   * only by version — without it the second is silently dropped, which is the
   * exact bug a naive dedupe on `(type, bookingId)` introduces.
   */
  | {
      type: typeof NotificationTypes.BOOKING_UPDATED;
      channel: NotificationChannel;
      bookingId: string;
      bookingVersion: number;
    }
  /** Terminal: a booking is cancelled once. */
  | {
      type: typeof NotificationTypes.BOOKING_CANCELLED;
      channel: NotificationChannel;
      bookingId: string;
    }
  /**
   * Keyed on the appointment's start, not the booking. Move the appointment and
   * the customer is owed a fresh reminder for the new time; redeliver the same
   * event and they are not.
   */
  | {
      type: typeof NotificationTypes.BOOKING_REMINDER;
      channel: NotificationChannel;
      bookingId: string;
      startAtIso: string;
    }
  /**
   * Staff-facing, and the failure it reports persists until someone fixes it.
   * Keyed per day so a broken integration nags once a morning rather than once
   * per sync attempt.
   */
  | {
      type: typeof NotificationTypes.CALENDAR_DISCONNECTED;
      channel: NotificationChannel;
      integrationId: string;
      dayIso: string;
    }
  /**
   * Keyed on the outbox event, not the tenant. Provisioning emits one event and
   * owes one email; a resent invitation emits another event and owes another,
   * legitimately. Keying on the tenant would send the first and silently
   * swallow every resend — which is the support path, so it would fail exactly
   * when someone is already stuck.
   */
  | {
      type: typeof NotificationTypes.ORGANIZATION_CREATED;
      channel: NotificationChannel;
      eventId: string;
    }
  /**
   * Keyed on the outbox event for the same reason as ORGANIZATION_CREATED, which
   * this is the staff-side sibling of: re-inviting a provider means "they never
   * got it", so it emits another event and owes another email. Keying on the
   * provider would send the first and swallow every resend — and a resend is
   * the recovery path (docs/phase-9-provider-onboarding.md §2.5).
   */
  | {
      type: typeof NotificationTypes.PROVIDER_INVITED;
      channel: NotificationChannel;
      eventId: string;
    }
  | {
      /**
       * Keyed on the outbox event, not the tenant: an owner who clicks
       * Subscribe twice should receive two emails, because the second click
       * almost always means the first did not arrive.
       */
      type: typeof NotificationTypes.SUBSCRIPTION_LINK;
      channel: NotificationChannel;
      eventId: string;
    }
  /**
   * Keyed on the outbox event, which is keyed on the Stripe event.
   *
   * Stripe sends `trial_will_end` once per trial, so this is one email either
   * way — but a redelivered webhook writes no second outbox row (the primary
   * key on `stripe_events` refuses it), so the event id is already the right
   * grain. Keying on the tenant would be wrong for a customer who trials,
   * cancels and returns.
   */
  | {
      type: typeof NotificationTypes.TRIAL_ENDING_SOON;
      channel: NotificationChannel;
      eventId: string;
    }
  /**
   * Likewise per event, and here the distinction earns its keep: Stripe retries
   * a declined renewal several times over the dunning window and each attempt
   * is a separate `invoice.payment_failed`. Each one is worth an email, because
   * each is a fresh chance to fix the card before the subscription is cancelled
   * (docs/phase-9-subscription-lifecycle.md §2.3). Keying on the tenant would
   * send the first and swallow the rest — the ones that matter most.
   */
  | {
      type: typeof NotificationTypes.SUBSCRIPTION_PAYMENT_FAILED;
      channel: NotificationChannel;
      eventId: string;
    }
  /**
   * **The one keyed on the subject rather than the event**, and the reason the
   * distinction in this file earns its keep.
   *
   * A subscription goes live once but reports itself many times: Stripe sends
   * `customer.subscription.updated` for every later change — a card swap, a plan
   * change, a renewal — and each carries a live status. Keyed on the event id
   * like its neighbours, this would congratulate the owner on subscribing every
   * time they touched their billing settings.
   *
   * Keyed on the subscription it confirms, a customer who cancels and comes back
   * still gets a fresh one, because that is a new Stripe subscription with a new
   * id. Which is right: they did subscribe again.
   */
  | {
      type: typeof NotificationTypes.SUBSCRIPTION_CONFIRMED;
      channel: NotificationChannel;
      subscriptionId: string;
    };

/**
 * Build the key.
 *
 * Every part is checked for the separator rather than escaped: the inputs are
 * cuid2 ids and ISO timestamps, none of which can contain a colon in a position
 * that matters, so a value that does is a bug upstream and should say so here
 * rather than produce a key that parses two ways.
 */
export function buildDedupeKey(input: DedupeInput): string {
  const parts: string[] = [SCHEME, input.type, input.channel, ...discriminatorFor(input)];

  for (const part of parts) {
    if (part === "") {
      throw new Error(`dedupe key part must not be empty (type ${input.type})`);
    }
    if (part.includes(SEPARATOR)) {
      throw new Error(
        `dedupe key part must not contain "${SEPARATOR}": received ${JSON.stringify(part)}`,
      );
    }
  }

  return parts.join(SEPARATOR);
}

function discriminatorFor(input: DedupeInput): string[] {
  switch (input.type) {
    case NotificationTypes.BOOKING_CONFIRMATION:
    case NotificationTypes.BOOKING_CANCELLED:
      return [input.bookingId];

    case NotificationTypes.BOOKING_UPDATED:
      return [input.bookingId, `v${String(input.bookingVersion)}`];

    case NotificationTypes.BOOKING_REMINDER:
      // Colons in the ISO instant would make the key ambiguous, so it travels
      // as its epoch-millisecond equivalent. Rejecting an unparseable value is
      // deliberate: a reminder keyed on "Invalid Date" would dedupe against
      // every other broken reminder for the booking.
      return [input.bookingId, epochMillisOf(input.startAtIso, "startAtIso")];

    case NotificationTypes.CALENDAR_DISCONNECTED:
      return [input.integrationId, input.dayIso];

    case NotificationTypes.ORGANIZATION_CREATED:
    case NotificationTypes.PROVIDER_INVITED:
    case NotificationTypes.SUBSCRIPTION_LINK:
    case NotificationTypes.TRIAL_ENDING_SOON:
    case NotificationTypes.SUBSCRIPTION_PAYMENT_FAILED:
      return [input.eventId];

    // `sub_…`, so the confirmation survives every later event about the same
    // subscription. See the comment on the variant.
    case NotificationTypes.SUBSCRIPTION_CONFIRMED:
      return [input.subscriptionId];
  }
}

function epochMillisOf(iso: string, field: string): string {
  const millis = Date.parse(iso);

  if (Number.isNaN(millis)) {
    throw new Error(
      `${field} must be a parseable ISO-8601 instant: received ${JSON.stringify(iso)}`,
    );
  }

  return String(millis);
}

/** The `YYYY-MM-DD` a UTC instant falls on. Used for once-a-day staff alerts. */
export function utcDayOf(instantIso: string): string {
  const millis = Date.parse(instantIso);

  if (Number.isNaN(millis)) {
    throw new Error(
      `expected a parseable ISO-8601 instant: received ${JSON.stringify(instantIso)}`,
    );
  }

  const day = new Date(millis).toISOString().slice(0, 10);
  return day;
}

export type { NotificationType };
