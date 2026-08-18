import { ErrorCodes } from "@bam/contracts";
import { ApiError, type ScheduleLastChange } from "./api-client";

/**
 * Reading a `SCHEDULE_MODIFIED` refusal.
 * docs/phase-3-4-diary-delegation.md §2.14.
 *
 * The week is saved as a whole set, so a body built from a stale read would
 * silently revert whoever saved in between — and since diary delegation a second
 * editor is the expected arrangement, not a rarity. The API now refuses that
 * save and names the other editor in `details.lastChange`.
 *
 * A sibling of `affectedBookingsOf`, and deliberately shaped like it: both turn
 * one 409 on the same route back into the thing the screen has to show. They are
 * different answers, though, and the screens must not merge them — a stranded
 * booking is re-sent with an acknowledgement, while this one may never be
 * re-sent as-is. That is the whole distinction between the two codes.
 *
 * Returns `undefined` for "not this error", and `null` for "this error, but the
 * audit trail had not caught up" — the trail is written fire-and-forget, so a
 * conflict discovered milliseconds after the other save can legitimately have
 * nobody to name. Both are refusals; only one can say by whom.
 */
export function scheduleModifiedBy(cause: unknown): ScheduleLastChange | null | undefined {
  if (!(cause instanceof ApiError)) return undefined;
  if (cause.code !== ErrorCodes.SCHEDULE_MODIFIED) return undefined;

  const details = cause.details;
  if (typeof details !== "object" || details === null) return null;

  const lastChange = (details as { lastChange?: unknown }).lastChange;
  if (typeof lastChange !== "object" || lastChange === null) return null;

  const entry = lastChange as Record<string, unknown>;
  if (typeof entry["at"] !== "string") return null;

  const by = entry["by"];
  if (typeof by !== "object" || by === null) return { at: entry["at"], by: null };

  const named = by as Record<string, unknown>;
  if (typeof named["userId"] !== "string" || typeof named["name"] !== "string") {
    // A refusal we can still make, minus the name. Better than discarding the
    // whole payload over a field the reader was only going to be told.
    return { at: entry["at"], by: null };
  }

  return { at: entry["at"], by: { userId: named["userId"], name: named["name"] } };
}
