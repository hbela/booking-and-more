import type { OccupiedSpan, Span } from "./types.js";

const MINUTE_MS = 60_000;

/**
 * Parse an ISO instant to epoch milliseconds.
 *
 * Throws rather than returning NaN. A malformed instant that flows onward
 * silently becomes a reservation spanning `Invalid Date`, which Postgres
 * rejects far away from the mistake — the same failure mode the availability
 * CHECK constraints exist to prevent.
 */
export function parseInstant(iso: string): number {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) {
    throw new RangeError(`Not an ISO 8601 instant: ${JSON.stringify(iso)}`);
  }
  return ms;
}

export function toInstant(ms: number): string {
  return new Date(ms).toISOString();
}

/**
 * Work out what an appointment occupies.
 *
 * This is the load-bearing function of the package, because it is the *only*
 * definition of the diary block. Three things must agree about a booked slot,
 * or the system either double-books or offers time nobody can use:
 *
 *   1. `AvailableSlot.occupiedFrom/occupiedUntil` from @bam/availability-engine,
 *   2. the `capacity_reservations` row this produces,
 *   3. the `DateTimePeriod` handed back to the next availability search.
 *
 * They agree because all three come from here. `spans.property.test.ts` asserts
 * the first against the third directly.
 *
 * Buffers extend the block outward and never move the appointment: a customer
 * told 10:00 arrives at 10:00 whatever the turnaround time is.
 */
export function occupiedSpanFor(input: {
  startAt: string;
  durationMinutes: number;
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
}): OccupiedSpan {
  const { durationMinutes, bufferBeforeMinutes, bufferAfterMinutes } = input;

  if (!Number.isInteger(durationMinutes) || durationMinutes <= 0) {
    throw new RangeError(
      `durationMinutes must be a positive integer, got ${String(durationMinutes)}`,
    );
  }
  if (!Number.isInteger(bufferBeforeMinutes) || bufferBeforeMinutes < 0) {
    throw new RangeError(
      `bufferBeforeMinutes must be a non-negative integer, got ${String(bufferBeforeMinutes)}`,
    );
  }
  if (!Number.isInteger(bufferAfterMinutes) || bufferAfterMinutes < 0) {
    throw new RangeError(
      `bufferAfterMinutes must be a non-negative integer, got ${String(bufferAfterMinutes)}`,
    );
  }

  const start = parseInstant(input.startAt);
  const end = start + durationMinutes * MINUTE_MS;

  return {
    appointment: { startAt: toInstant(start), endAt: toInstant(end) },
    occupied: {
      startAt: toInstant(start - bufferBeforeMinutes * MINUTE_MS),
      endAt: toInstant(end + bufferAfterMinutes * MINUTE_MS),
    },
  };
}

/**
 * Half-open overlap: `[aStart, aEnd)` against `[bStart, bEnd)`.
 *
 * Back-to-back does not overlap — an appointment ending at 10:00 and one
 * starting at 10:00 are two appointments, not a conflict. This is the same
 * convention as the `tstzrange(start_at, end_at, '[)')` in the exclusion
 * constraint, and as @bam/availability-engine's interval algebra. Getting one
 * of the three wrong turns every adjacency into a one-millisecond argument.
 */
export function spansOverlap(left: Span, right: Span): boolean {
  const leftStart = parseInstant(left.startAt);
  const leftEnd = parseInstant(left.endAt);
  const rightStart = parseInstant(right.startAt);
  const rightEnd = parseInstant(right.endAt);

  return leftStart < rightEnd && rightStart < leftEnd;
}

export function durationMinutesOf(span: Span): number {
  return (parseInstant(span.endAt) - parseInstant(span.startAt)) / MINUTE_MS;
}

/** Whether a span is well-formed: it must end strictly after it starts. */
export function isPositiveSpan(span: Span): boolean {
  return parseInstant(span.endAt) > parseInstant(span.startAt);
}
