import { parseInstant } from "./spans.js";
import { isTerminal } from "./transitions.js";
import { ALLOWED, BookingStatuses, refuse, type BookingStatus, type Decision } from "./types.js";

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

export type BookingWindowRefusal =
  "MINIMUM_NOTICE_NOT_MET" | "OUTSIDE_BOOKING_WINDOW" | "IN_THE_PAST";

/**
 * Is this start time still bookable?
 *
 * ## Why this is checked again at write time
 *
 * @bam/availability-engine already applies the notice and advance windows when
 * it generates slots, so everything a customer can click is valid *at the
 * moment of the search*. Then they spend four minutes typing their phone
 * number.
 *
 * A search at 08:58 for a service needing an hour's notice offers 10:00
 * legitimately; confirming at 09:05 does not. Re-checking here is what stops
 * the window being enforced only against people who fill forms in quickly. The
 * check is cheap and the failure it prevents is the kind nobody notices until a
 * provider complains that bookings keep appearing inside their notice period.
 *
 * `minimumNoticeMinutes` and `maximumAdvanceDays` arrive already resolved — the
 * API applies the same most-restrictive-wins inheritance the slot search uses.
 */
export function checkBookingWindow(input: {
  startAt: string;
  now: string;
  minimumNoticeMinutes: number;
  maximumAdvanceDays: number;
}): Decision<BookingWindowRefusal> {
  const start = parseInstant(input.startAt);
  const now = parseInstant(input.now);

  if (start < now) {
    return refuse("IN_THE_PAST", { startAt: input.startAt });
  }

  const earliest = now + input.minimumNoticeMinutes * MINUTE_MS;
  if (start < earliest) {
    return refuse("MINIMUM_NOTICE_NOT_MET", {
      minimumNoticeMinutes: input.minimumNoticeMinutes,
      earliestStartAt: new Date(earliest).toISOString(),
    });
  }

  const latest = now + input.maximumAdvanceDays * DAY_MS;
  if (start > latest) {
    return refuse("OUTSIDE_BOOKING_WINDOW", {
      maximumAdvanceDays: input.maximumAdvanceDays,
      latestStartAt: new Date(latest).toISOString(),
    });
  }

  return ALLOWED;
}

export type CancellationRefusal =
  "BOOKING_ALREADY_CANCELLED" | "BOOKING_TERMINAL" | "TOO_LATE_TO_CANCEL" | "ALREADY_STARTED";

/**
 * May this booking be cancelled?
 *
 * ## On `cancellationNoticeMinutes`
 *
 * It is a parameter and not a column. `Tenant.cancellationPolicy` is free text
 * shown to the customer before they confirm (PRD §7, tech-impl §30 step 7), and
 * nothing in the data model states a *number* of minutes. Rather than invent a
 * column no spec asks for, the rule is expressible here and the API passes
 * `null` — the day a tenant needs "no cancellations within 24 hours", the
 * column is added and threaded to this argument, and this function does not
 * change.
 *
 * What always applies is the rule that needs no configuration: an appointment
 * that has already started cannot be cancelled, only marked NO_SHOW by staff.
 * Cancelling it would release capacity for time that has already been spent and
 * quietly rewrite what happened.
 */
export function checkCancellable(input: {
  status: BookingStatus;
  startAt: string;
  now: string;
  cancellationNoticeMinutes: number | null;
}): Decision<CancellationRefusal> {
  if (input.status === BookingStatuses.CANCELLED) {
    return refuse("BOOKING_ALREADY_CANCELLED");
  }
  if (isTerminal(input.status)) {
    return refuse("BOOKING_TERMINAL", { status: input.status });
  }

  const start = parseInstant(input.startAt);
  const now = parseInstant(input.now);

  if (start <= now) {
    return refuse("ALREADY_STARTED", { startAt: input.startAt });
  }

  if (input.cancellationNoticeMinutes !== null) {
    const deadline = start - input.cancellationNoticeMinutes * MINUTE_MS;
    if (now > deadline) {
      return refuse("TOO_LATE_TO_CANCEL", {
        cancellationNoticeMinutes: input.cancellationNoticeMinutes,
        deadlineAt: new Date(deadline).toISOString(),
      });
    }
  }

  return ALLOWED;
}

export type RescheduleRefusal = CancellationRefusal | BookingWindowRefusal | "SAME_TIME";

/**
 * May this booking move to a new time?
 *
 * A reschedule is a cancellation and a booking welded together, so it answers
 * to both sets of rules: the old appointment must still be cancellable, and the
 * new one must sit inside the booking window. Checking only the second is the
 * obvious bug — it would let somebody escape a cancellation policy by moving an
 * appointment instead of cancelling it.
 *
 * The atomicity that makes this safe is the API's job (one transaction, new
 * reservation acquired before the old one is released). This function decides
 * only whether it is permitted to try.
 */
export function checkReschedulable(input: {
  status: BookingStatus;
  currentStartAt: string;
  newStartAt: string;
  now: string;
  cancellationNoticeMinutes: number | null;
  minimumNoticeMinutes: number;
  maximumAdvanceDays: number;
}): Decision<RescheduleRefusal> {
  if (parseInstant(input.newStartAt) === parseInstant(input.currentStartAt)) {
    // Not an error the customer caused so much as a request that means nothing.
    // Letting it through would burn a reservation cycle and write an audit
    // entry describing a change that did not happen.
    return refuse("SAME_TIME");
  }

  const leaving = checkCancellable({
    status: input.status,
    startAt: input.currentStartAt,
    now: input.now,
    cancellationNoticeMinutes: input.cancellationNoticeMinutes,
  });
  if (!leaving.allowed) return leaving;

  return checkBookingWindow({
    startAt: input.newStartAt,
    now: input.now,
    minimumNoticeMinutes: input.minimumNoticeMinutes,
    maximumAdvanceDays: input.maximumAdvanceDays,
  });
}

/**
 * The most restrictive value wins, NULL meaning "inherit".
 *
 * Duplicated in spirit from AvailabilityService, and deliberately re-stated
 * here so the write path cannot drift from the search path: a provider needing
 * a day's warning and a service needing two hours means a day, because the
 * stricter is the one that would be violated.
 */
export function mostRestrictiveNotice(values: (number | null)[], fallback: number): number {
  const set = values.filter((value): value is number => value !== null);
  return set.length === 0 ? fallback : Math.max(...set);
}

/** Same rule, opposite direction: the shortest booking horizon wins. */
export function mostRestrictiveAdvance(values: (number | null)[], fallback: number): number {
  const set = values.filter((value): value is number => value !== null);
  return set.length === 0 ? fallback : Math.min(...set);
}
