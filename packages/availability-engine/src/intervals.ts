import type { Interval } from "./types.js";

/**
 * Interval algebra over half-open millisecond spans `[start, end)`.
 *
 * Half-open is the decision that makes everything else fall out: an appointment
 * ending at 10:00 and one starting at 10:00 do not overlap, which is exactly
 * what "back-to-back" means to the person keeping the diary. With closed
 * intervals every adjacency becomes a one-millisecond argument.
 *
 * Empty and inverted spans are dropped rather than rejected. A working period
 * of zero length is not an error the caller can act on — it is simply no time.
 */

/** Sort, drop the empty, and merge everything that touches or overlaps. */
export function normalize(intervals: Interval[]): Interval[] {
  const sorted = intervals
    .filter((interval) => interval.end > interval.start)
    .sort((left, right) => left.start - right.start || left.end - right.end);

  const merged: Interval[] = [];

  for (const interval of sorted) {
    const last = merged.at(-1);

    // `>=` not `>`: two spans that merely touch are one span. Leaving them
    // separate would put a zero-width seam in the middle of a working day, and
    // no slot could ever straddle it.
    if (last && interval.start <= last.end) {
      last.end = Math.max(last.end, interval.end);
      continue;
    }

    merged.push({ ...interval });
  }

  return merged;
}

/** Everything in `from` that is not in `remove`. Both are normalized first. */
export function subtract(from: Interval[], remove: Interval[]): Interval[] {
  const blockers = normalize(remove);
  let remaining = normalize(from);

  for (const blocker of blockers) {
    const next: Interval[] = [];

    for (const interval of remaining) {
      // Disjoint: nothing to cut.
      if (blocker.end <= interval.start || blocker.start >= interval.end) {
        next.push(interval);
        continue;
      }

      // A piece may survive on either side, or on both when the blocker sits
      // strictly inside — a lunch break splitting a working day in two.
      if (blocker.start > interval.start) {
        next.push({ start: interval.start, end: blocker.start });
      }
      if (blocker.end < interval.end) {
        next.push({ start: blocker.end, end: interval.end });
      }
    }

    remaining = next;
  }

  return remaining;
}

/** Restrict `intervals` to the part inside `bounds`. */
export function clamp(intervals: Interval[], bounds: Interval): Interval[] {
  return normalize(
    intervals.map((interval) => ({
      start: Math.max(interval.start, bounds.start),
      end: Math.min(interval.end, bounds.end),
    })),
  );
}

/** Is `candidate` wholly inside one of these (normalized) intervals? */
export function contains(intervals: Interval[], candidate: Interval): boolean {
  // A zero-length candidate is contained by anything covering its instant; the
  // engine never asks, but leaving it undefined would be a trap for the next
  // caller.
  return intervals.some(
    (interval) => interval.start <= candidate.start && interval.end >= candidate.end,
  );
}

/** Total covered milliseconds, counting overlaps once. */
export function totalDuration(intervals: Interval[]): number {
  return normalize(intervals).reduce((sum, interval) => sum + (interval.end - interval.start), 0);
}
