import { ErrorCodes, type AffectedBooking } from "@bam/contracts";
import { ApiError } from "./api-client";

/**
 * Reading a `SCHEDULE_CONFLICTS_BOOKINGS` refusal.
 * docs/phase-3-4-schedule-conflicts.md §2.4.
 *
 * The API refuses a schedule change that would strand existing bookings, once,
 * and carries the list in `details.affectedBookings`. This turns that error back
 * into the list, or null when the failure was something else entirely.
 *
 * Separate from the components because two editors need it — working hours and
 * time off — and because a narrowing of `unknown` is a thing to test as a
 * function rather than through a rendered dialog.
 */
export function affectedBookingsOf(cause: unknown): AffectedBooking[] | null {
  if (!(cause instanceof ApiError)) return null;
  if (cause.code !== ErrorCodes.SCHEDULE_CONFLICTS_BOOKINGS) return null;

  const details = cause.details;
  if (typeof details !== "object" || details === null) return null;

  const list = (details as { affectedBookings?: unknown }).affectedBookings;
  if (!Array.isArray(list)) return null;

  // Filtered rather than cast. The server owns this shape and validates it on
  // the way out, but a dialog that renders `undefined — undefined` because a
  // field was renamed is worse than one that renders nothing, and this is the
  // screen somebody reaches when something is already wrong.
  const usable = list.filter((entry): entry is AffectedBooking => isAffectedBooking(entry));

  // An empty list would render a dialog asking about nothing. Treat it as "not
  // this error" so the caller falls through to its ordinary message.
  return usable.length === 0 ? null : usable;
}

function isAffectedBooking(value: unknown): value is AffectedBooking {
  if (typeof value !== "object" || value === null) return false;

  const entry = value as Record<string, unknown>;

  return (
    typeof entry["id"] === "string" &&
    typeof entry["reference"] === "string" &&
    typeof entry["startAt"] === "string" &&
    // Nullable since diary delegation: a caller who may manage this diary's
    // availability but not read its bookings gets the list without names
    // (docs/phase-3-4-diary-delegation.md §2.12). The dialog copes; this guard
    // must not reject the whole payload over it.
    (typeof entry["customerName"] === "string" || entry["customerName"] === null) &&
    typeof entry["serviceName"] === "string" &&
    typeof entry["providerName"] === "string" &&
    (entry["reason"] === "OUTSIDE_WORKING_HOURS" || entry["reason"] === "BLOCKED_BY_EXCEPTION")
  );
}
