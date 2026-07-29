import { clamp, contains, normalize, subtract } from "./intervals.js";
import type {
  AvailabilityQuery,
  AvailableSlot,
  DateTimePeriod,
  Interval,
  TimePeriod,
} from "./types.js";
import {
  addDays,
  dateOnlyAt,
  eachDate,
  parseDateOnly,
  parseTimeOfDay,
  resolveWallClock,
  weekdayOf,
  type DateOnly,
} from "./zone.js";

/**
 * Slot generation. tech-impl §13.3.
 *
 * Pure: no Fastify, no Prisma, no Redis, no clock. Given the same query it
 * returns the same slots, on any machine, in any month — which is what makes
 * the daylight-saving cases testable at all (CLAUDE.md rule 8).
 *
 * ## Two rules worth stating before the code
 *
 * **Buffers occupy the diary, so they must fit.** A slot is offered only when
 * its *whole* occupied window — before-buffer, appointment, after-buffer — sits
 * inside available time. A clinic opening at 09:00 with a ten-minute
 * before-buffer therefore offers 09:10 as its first appointment, not 09:00: the
 * preparation cannot happen before the provider has arrived. The alternative
 * reading, where buffers apply only between appointments, quietly books people
 * into time nobody is there for.
 *
 * **The slot grid is anchored to the working period, not to the gaps.** Start
 * times step from the opening time, so they stay at 09:00, 09:15, 09:30 as
 * bookings come and go. Anchoring to each free gap instead would make the
 * offered times shuffle every time someone else booked, which reads as a bug to
 * anyone refreshing the page.
 */
export function generateSlots(query: AvailabilityQuery): AvailableSlot[] {
  assertQueryIsSane(query);

  const nowMs = Date.parse(query.now);
  const { timezone } = query;

  // Step 1 — working periods, in the provider's zone.
  //
  // The day before `dateFrom` is included because a period that runs past
  // midnight belongs to the day it started on; without it, a night shift would
  // lose the hours it contributes to the first requested morning.
  const dates = eachDate(addDays(query.dateFrom, -1), query.dateTo);
  const working = dates.flatMap((date) =>
    query.workingPeriods
      .filter((period) => appliesOn(period, date))
      .map((period) => periodToInterval(period, date, timezone)),
  );

  // Step 2 — one-off openings.
  const available = normalize([...working, ...toIntervals(query.additionalPeriods)]);

  // Steps 3–6 — everything that takes time away. They differ in provenance and
  // in nothing else, so they are subtracted together.
  const free = subtract(available, [
    ...toIntervals(query.unavailablePeriods),
    ...toIntervals(query.bookings),
    ...toIntervals(query.activeHolds),
    ...toIntervals(query.externalBusyPeriods),
  ]);

  // Steps 9–10 — the booking window. Computed once, then applied as bounds on
  // the slot start rather than re-checked per slot.
  const window = bookingWindow(query, nowMs);
  if (window === null) return [];

  // Steps 7–8 — walk the grid of each availability window and keep the starts
  // whose occupied span fits in free time.
  const durationMs = query.serviceDurationMinutes * 60_000;
  const beforeMs = query.bufferBeforeMinutes * 60_000;
  const afterMs = query.bufferAfterMinutes * 60_000;
  const stepMs = query.slotIntervalMinutes * 60_000;

  const slots = new Map<number, AvailableSlot>();

  for (const anchor of available) {
    for (let start = anchor.start; start + durationMs <= anchor.end; start += stepMs) {
      if (start < window.start || start > window.end) continue;

      const occupied: Interval = { start: start - beforeMs, end: start + durationMs + afterMs };

      if (!contains(free, occupied)) continue;

      // Keyed by start: two overlapping availability windows can propose the
      // same instant, and the customer should be offered it once.
      slots.set(start, {
        startAt: toIso(start),
        endAt: toIso(start + durationMs),
        occupiedFrom: toIso(occupied.start),
        occupiedUntil: toIso(occupied.end),
      });
    }
  }

  // Step 11 — chronological order.
  return [...slots.values()].sort(
    (left, right) => Date.parse(left.startAt) - Date.parse(right.startAt),
  );
}

/**
 * The span within which a slot may start.
 *
 * Three constraints, intersected:
 *
 *   the requested range — `dateFrom`..`dateTo`, as calendar days in the
 *                         provider's zone. Needed as a bound in its own right
 *                         because step 1 deliberately looks a day further back
 *                         to pick up night shifts; without this, asking about
 *                         Tuesday would return Monday's 22:00.
 *   minimum notice      — measured from `now`.
 *   maximum advance     — measured in calendar days from today in the
 *                         provider's zone, so "bookable 60 days ahead" means
 *                         the same thing whatever the hour, and runs to the
 *                         close of that day rather than to the current time of
 *                         day.
 *
 * Returns null when the intersection is empty.
 */
function bookingWindow(query: AvailabilityQuery, nowMs: number): Interval | null {
  const requestedFrom = startOfDay(query.dateFrom, query.timezone);
  // Midnight ending the last requested day, exclusive: a slot starting exactly
  // at midnight belongs to the following day.
  const requestedTo = startOfDay(addDays(query.dateTo, 1), query.timezone) - 1;

  const today = dateOnlyAt(nowMs, query.timezone);
  const lastPermittedDay = addDays(today, query.maximumAdvanceDays);

  const start = Math.max(requestedFrom, nowMs + query.minimumNoticeMinutes * 60_000);
  const end = Math.min(requestedTo, startOfDay(addDays(lastPermittedDay, 1), query.timezone) - 1);

  return start > end ? null : { start, end };
}

/** Does this recurring period apply on this calendar date? */
function appliesOn(period: TimePeriod, date: DateOnly): boolean {
  if (period.weekday !== weekdayOf(date)) return false;
  if (period.validFrom !== undefined && date < period.validFrom) return false;
  if (period.validUntil !== undefined && date > period.validUntil) return false;
  return true;
}

/**
 * Turn a recurring period into an absolute span on a given date.
 *
 * Both ends are resolved through the zone, separately. Resolving the start and
 * then adding the duration would be the bug §13.4 warns about: on a
 * spring-forward day 09:00–17:00 is seven hours of wall clock, not eight, and
 * an appointment at 16:30 is still inside it.
 */
function periodToInterval(period: TimePeriod, date: DateOnly, timeZone: string): Interval {
  const startMinutes = parseTimeOfDay(period.startTime);
  const endMinutes = parseTimeOfDay(period.endTime);

  // An end at or before the start means the period runs into the next day.
  const endsNextDay = endMinutes <= startMinutes;

  return {
    start: instantOf(date, startMinutes, timeZone),
    end: instantOf(endsNextDay ? addDays(date, 1) : date, endMinutes, timeZone),
  };
}

/**
 * The instant at `minutes` past local midnight on `date`.
 *
 * Minutes are carried into the date before resolving, so `24:00` is midnight on
 * the following day rather than an hour the clock does not have.
 */
function instantOf(date: DateOnly, minutesFromMidnight: number, timeZone: string): number {
  const dayOffset = Math.floor(minutesFromMidnight / 1440);
  const withinDay = minutesFromMidnight - dayOffset * 1440;
  const { year, month, day } = parseDateOnly(addDays(date, dayOffset));

  return resolveWallClock(
    {
      year,
      month,
      day,
      hour: Math.floor(withinDay / 60),
      minute: withinDay % 60,
    },
    timeZone,
  ).epochMs;
}

function startOfDay(date: DateOnly, timeZone: string): number {
  return instantOf(date, 0, timeZone);
}

function toIntervals(periods: DateTimePeriod[]): Interval[] {
  return periods.map((period) => ({
    start: Date.parse(period.startAt),
    end: Date.parse(period.endAt),
  }));
}

function toIso(epochMs: number): string {
  return new Date(epochMs).toISOString();
}

/**
 * Fail loudly on a query that cannot mean anything.
 *
 * These are caller bugs, not user input — the API validates its own request
 * bodies with Zod long before this. Catching them here stops a nonsensical
 * query from returning a confident empty list, which is the failure mode that
 * wastes an afternoon.
 */
function assertQueryIsSane(query: AvailabilityQuery): void {
  if (!Number.isFinite(Date.parse(query.now))) {
    throw new Error(`\`now\` is not a valid instant: ${query.now}`);
  }
  if (query.serviceDurationMinutes <= 0) {
    throw new Error(
      `Service duration must be positive, got ${String(query.serviceDurationMinutes)}`,
    );
  }
  if (query.slotIntervalMinutes <= 0) {
    throw new Error(`Slot interval must be positive, got ${String(query.slotIntervalMinutes)}`);
  }
  if (query.bufferBeforeMinutes < 0 || query.bufferAfterMinutes < 0) {
    throw new Error("Buffers cannot be negative");
  }
  if (query.maximumAdvanceDays < 0) {
    throw new Error(
      `Maximum advance days cannot be negative, got ${String(query.maximumAdvanceDays)}`,
    );
  }
  if (query.minimumNoticeMinutes < 0) {
    throw new Error(`Minimum notice cannot be negative, got ${String(query.minimumNoticeMinutes)}`);
  }

  // Parsed for their side effect: both throw on a malformed date, and finding
  // out here beats an empty result from `eachDate`.
  parseDateOnly(query.dateFrom);
  parseDateOnly(query.dateTo);
}

/** Convenience for callers that only need to know whether anything is free. */
export function hasAvailability(query: AvailabilityQuery): boolean {
  return generateSlots(query).length > 0;
}

/** Re-exported so the engine's own interval helpers stay testable in isolation. */
export { clamp, contains, normalize, subtract };
