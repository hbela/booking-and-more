import { parseInstant, toInstant } from "./spans.js";
import { ALLOWED, HoldStatuses, refuse, type Decision, type HoldStatus } from "./types.js";

/**
 * How long a slot stays reserved while the customer fills in the form.
 * PRD §9.8.
 *
 * Long enough to type a name and a phone number, short enough that an abandoned
 * checkout does not cost the next customer their appointment.
 */
export const DEFAULT_HOLD_DURATION_MINUTES = 5;

/**
 * ## Why expiry is computed rather than scheduled
 *
 * There is no scheduler here. Redis and BullMQ arrive in Epic 5, and until then
 * nothing runs on a timer to move a hold from ACTIVE to EXPIRED.
 *
 * So a hold expires by *arithmetic*, not by an event: `expires_at` is the truth
 * and `status` is a cache of it. Every read goes through
 * {@link effectiveHoldStatus}, which reports what the row means right now
 * rather than what it last got written as.
 *
 * That leaves one real problem, and it is a database problem rather than a
 * TypeScript one. The exclusion constraint on `capacity_reservations` fires on
 * `WHERE status = 'ACTIVE'`, and a constraint predicate cannot call `now()` —
 * so an expired-but-unswept reservation goes on blocking its slot forever. The
 * API therefore sweeps expired reservations inside the same transaction that
 * creates a new hold, which is the one moment the answer is guaranteed to
 * matter. Epic 5 can add a periodic sweep on top; it will be an optimisation,
 * not a correctness fix.
 */
export function effectiveHoldStatus(
  hold: { status: HoldStatus; expiresAt: string },
  now: string,
): HoldStatus {
  if (hold.status !== HoldStatuses.ACTIVE) return hold.status;
  return parseInstant(now) >= parseInstant(hold.expiresAt)
    ? HoldStatuses.EXPIRED
    : HoldStatuses.ACTIVE;
}

export function holdExpiresAt(now: string, durationMinutes: number): string {
  if (!Number.isInteger(durationMinutes) || durationMinutes <= 0) {
    throw new RangeError(
      `durationMinutes must be a positive integer, got ${String(durationMinutes)}`,
    );
  }
  return toInstant(parseInstant(now) + durationMinutes * 60_000);
}

export type HoldRefusal = "HOLD_EXPIRED" | "HOLD_RELEASED" | "HOLD_ALREADY_CONFIRMED";

/**
 * May this hold still be turned into a booking?
 *
 * The three refusals are kept apart because they are three different things to
 * say to a customer. "Your reservation ran out" invites another attempt at the
 * same slot; "this was already booked" means their confirmation went through
 * and they should not try again.
 */
export function checkHoldUsable(
  hold: { status: HoldStatus; expiresAt: string },
  now: string,
): Decision<HoldRefusal> {
  switch (effectiveHoldStatus(hold, now)) {
    case HoldStatuses.ACTIVE:
      return ALLOWED;
    case HoldStatuses.EXPIRED:
      return refuse("HOLD_EXPIRED", { expiresAt: hold.expiresAt });
    case HoldStatuses.RELEASED:
      return refuse("HOLD_RELEASED");
    case HoldStatuses.CONFIRMED:
      return refuse("HOLD_ALREADY_CONFIRMED");
  }
}

/**
 * Seconds left on the countdown the booking page shows ("reserved for 4:38",
 * tech-impl §30 step 5). Never negative — an overrun reads as zero.
 */
export function holdRemainingSeconds(hold: { expiresAt: string }, now: string): number {
  const remaining = parseInstant(hold.expiresAt) - parseInstant(now);
  return remaining <= 0 ? 0 : Math.ceil(remaining / 1000);
}

/**
 * May a hold be released?
 *
 * Releasing an already-terminal hold is not an error worth surfacing: the
 * customer pressed "back" twice, or the request was retried. Only a hold that
 * became a booking refuses, because releasing that would free a slot somebody
 * is holding a confirmation for.
 */
export function checkHoldReleasable(hold: {
  status: HoldStatus;
}): Decision<"HOLD_ALREADY_CONFIRMED"> {
  return hold.status === HoldStatuses.CONFIRMED ? refuse("HOLD_ALREADY_CONFIRMED") : ALLOWED;
}
