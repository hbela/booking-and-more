import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { generateSlots } from "./engine.js";
import { normalize, subtract, totalDuration } from "./intervals.js";
import type { AvailabilityQuery, DateTimePeriod, Interval } from "./types.js";
import { addDays, wallClockToEpochMs } from "./zone.js";

/**
 * Property tests, per tech-impl §2.1's "fast-check for availability-engine
 * property tests".
 *
 * The example tests in engine.test.ts pin down the cases a person thought of.
 * These pin down the ones nobody did: they assert invariants that must hold for
 * every schedule, and let fast-check go looking for the schedule that breaks
 * them.
 *
 * The zones are chosen for awkwardness — a half-hour offset, a half-hour
 * transition, a southern hemisphere calendar — rather than for coverage.
 */

const ZONES = [
  "Europe/Budapest",
  "UTC",
  "America/New_York",
  "Asia/Kolkata",
  "Pacific/Auckland",
  "Australia/Lord_Howe",
] as const;

/** Dates around both European transitions, plus ordinary weeks. */
const startDates = fc.constantFrom(
  "2026-01-12",
  "2026-03-26",
  "2026-03-29",
  "2026-06-15",
  "2026-10-22",
  "2026-10-25",
  "2026-12-28",
);

const timeOfDay = fc.integer({ min: 0, max: 47 }).map((halfHours) => {
  const hour = Math.floor(halfHours / 2);
  const minute = halfHours % 2 === 0 ? 0 : 30;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
});

const workingPeriod = fc
  .record({
    weekday: fc.integer({ min: 1, max: 7 }),
    startTime: timeOfDay,
    endTime: timeOfDay,
  })
  // Drop the degenerate ones rather than generating around them: a period whose
  // end equals its start means "runs to the same time tomorrow", which is a
  // separate behaviour with its own example test.
  .filter((period) => period.startTime < period.endTime);

const arbitraryQuery = fc
  .record({
    zone: fc.constantFrom(...ZONES),
    dateFrom: startDates,
    days: fc.integer({ min: 0, max: 3 }),
    periods: fc.array(workingPeriod, { minLength: 0, maxLength: 4 }),
    durationMinutes: fc.constantFrom(15, 30, 45, 60, 90),
    slotIntervalMinutes: fc.constantFrom(15, 30, 60),
    bufferBeforeMinutes: fc.constantFrom(0, 5, 15),
    bufferAfterMinutes: fc.constantFrom(0, 10, 30),
  })
  .map(({ zone, dateFrom, days, periods, ...rest }): AvailabilityQuery => ({
    providerId: "prv_property",
    dateFrom,
    dateTo: addDays(dateFrom, days),
    timezone: zone,
    workingPeriods: periods,
    additionalPeriods: [],
    unavailablePeriods: [],
    bookings: [],
    activeHolds: [],
    externalBusyPeriods: [],
    minimumNoticeMinutes: 0,
    maximumAdvanceDays: 3650,
    now: "2026-01-01T00:00:00Z",
    serviceDurationMinutes: rest.durationMinutes,
    slotIntervalMinutes: rest.slotIntervalMinutes,
    bufferBeforeMinutes: rest.bufferBeforeMinutes,
    bufferAfterMinutes: rest.bufferAfterMinutes,
  }));

describe("slot generation invariants", () => {
  it("is deterministic", () => {
    // The Epic 3 exit criterion, stated as a property. Anything reading a clock
    // or iterating a Set of objects would fail here eventually.
    fc.assert(
      fc.property(arbitraryQuery, (query) => {
        expect(generateSlots(query)).toEqual(generateSlots(query));
      }),
      { numRuns: 200 },
    );
  });

  it("returns slots in strictly increasing order of start", () => {
    fc.assert(
      fc.property(arbitraryQuery, (query) => {
        const starts = generateSlots(query).map((slot) => Date.parse(slot.startAt));

        for (let index = 1; index < starts.length; index += 1) {
          expect(starts[index]!).toBeGreaterThan(starts[index - 1]!);
        }
      }),
      { numRuns: 200 },
    );
  });

  it("gives every slot exactly the service duration", () => {
    fc.assert(
      fc.property(arbitraryQuery, (query) => {
        for (const slot of generateSlots(query)) {
          expect(Date.parse(slot.endAt) - Date.parse(slot.startAt)).toBe(
            query.serviceDurationMinutes * 60_000,
          );
        }
      }),
      { numRuns: 200 },
    );
  });

  it("wraps every slot in exactly its buffers", () => {
    fc.assert(
      fc.property(arbitraryQuery, (query) => {
        for (const slot of generateSlots(query)) {
          expect(Date.parse(slot.startAt) - Date.parse(slot.occupiedFrom)).toBe(
            query.bufferBeforeMinutes * 60_000,
          );
          expect(Date.parse(slot.occupiedUntil) - Date.parse(slot.endAt)).toBe(
            query.bufferAfterMinutes * 60_000,
          );
        }
      }),
      { numRuns: 200 },
    );
  });

  it("never lets two slots occupy the diary at once", () => {
    // Not a property of the returned list — slots are *candidates*, and
    // adjacent candidates legitimately overlap when the interval is shorter
    // than the duration. What must hold is that each occupied span is a real
    // span: non-empty, and ordered.
    fc.assert(
      fc.property(arbitraryQuery, (query) => {
        for (const slot of generateSlots(query)) {
          expect(Date.parse(slot.occupiedUntil)).toBeGreaterThan(Date.parse(slot.occupiedFrom));
          expect(Date.parse(slot.startAt)).toBeGreaterThanOrEqual(Date.parse(slot.occupiedFrom));
          expect(Date.parse(slot.endAt)).toBeLessThanOrEqual(Date.parse(slot.occupiedUntil));
        }
      }),
      { numRuns: 200 },
    );
  });

  it("keeps every slot inside the requested calendar range", () => {
    fc.assert(
      fc.property(arbitraryQuery, (query) => {
        const rangeStart = wallClockToEpochMs(
          {
            year: Number(query.dateFrom.slice(0, 4)),
            month: Number(query.dateFrom.slice(5, 7)),
            day: Number(query.dateFrom.slice(8, 10)),
            hour: 0,
            minute: 0,
          },
          query.timezone,
        );
        const afterRange = wallClockToEpochMs(
          {
            year: Number(addDays(query.dateTo, 1).slice(0, 4)),
            month: Number(addDays(query.dateTo, 1).slice(5, 7)),
            day: Number(addDays(query.dateTo, 1).slice(8, 10)),
            hour: 0,
            minute: 0,
          },
          query.timezone,
        );

        for (const slot of generateSlots(query)) {
          expect(Date.parse(slot.startAt)).toBeGreaterThanOrEqual(rangeStart);
          expect(Date.parse(slot.startAt)).toBeLessThan(afterRange);
        }
      }),
      { numRuns: 200 },
    );
  });

  it("offers nothing once every working hour is blocked out", () => {
    fc.assert(
      fc.property(arbitraryQuery, (query) => {
        const blocked: AvailabilityQuery = {
          ...query,
          unavailablePeriods: [{ startAt: "2020-01-01T00:00:00Z", endAt: "2040-01-01T00:00:00Z" }],
        };

        expect(generateSlots(blocked)).toEqual([]);
      }),
      { numRuns: 100 },
    );
  });

  it("never gains slots when time is taken away", () => {
    // Monotonicity. Blocking more time can only ever reduce what is on offer —
    // an obvious-sounding property, and exactly the one an off-by-one in the
    // subtraction would break.
    fc.assert(
      fc.property(
        arbitraryQuery,
        fc.integer({ min: 0, max: 23 }),
        fc.integer({ min: 1, max: 6 }),
        (query, startHour, lengthHours) => {
          const blockStart = `${query.dateFrom}T${String(startHour).padStart(2, "0")}:00:00Z`;
          const block: DateTimePeriod = {
            startAt: blockStart,
            endAt: new Date(Date.parse(blockStart) + lengthHours * 3_600_000).toISOString(),
          };

          const before = generateSlots(query);
          const after = generateSlots({ ...query, bookings: [block] });

          expect(after.length).toBeLessThanOrEqual(before.length);

          // And everything still offered was offered before.
          const previous = new Set(before.map((slot) => slot.startAt));
          for (const slot of after) {
            expect(previous.has(slot.startAt)).toBe(true);
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it("treats a booking, a hold and an external busy period identically", () => {
    // They differ in provenance and nothing else (§13.3 steps 4–6). If one day
    // they stop being interchangeable, this is where it surfaces.
    fc.assert(
      fc.property(arbitraryQuery, fc.integer({ min: 0, max: 23 }), (query, startHour) => {
        const block: DateTimePeriod = {
          startAt: `${query.dateFrom}T${String(startHour).padStart(2, "0")}:00:00Z`,
          endAt: `${query.dateFrom}T${String(startHour).padStart(2, "0")}:45:00Z`,
        };

        const asBooking = generateSlots({ ...query, bookings: [block] });
        const asHold = generateSlots({ ...query, activeHolds: [block] });
        const asExternal = generateSlots({ ...query, externalBusyPeriods: [block] });

        expect(asHold).toEqual(asBooking);
        expect(asExternal).toEqual(asBooking);
      }),
      { numRuns: 150 },
    );
  });
});

describe("interval algebra invariants", () => {
  const arbitraryIntervals = fc.array(
    fc
      .record({
        start: fc.integer({ min: 0, max: 10_000 }),
        length: fc.integer({ min: 0, max: 500 }),
      })
      .map(({ start, length }): Interval => ({ start, end: start + length })),
    { maxLength: 12 },
  );

  it("normalizes to a sorted, disjoint, non-touching set", () => {
    fc.assert(
      fc.property(arbitraryIntervals, (intervals) => {
        const merged = normalize(intervals);

        for (let index = 1; index < merged.length; index += 1) {
          // Strictly after, not merely non-overlapping: touching spans are one
          // span, or a slot could never straddle the seam.
          expect(merged[index]!.start).toBeGreaterThan(merged[index - 1]!.end);
        }
        for (const interval of merged) {
          expect(interval.end).toBeGreaterThan(interval.start);
        }
      }),
      { numRuns: 300 },
    );
  });

  it("is idempotent", () => {
    fc.assert(
      fc.property(arbitraryIntervals, (intervals) => {
        expect(normalize(normalize(intervals))).toEqual(normalize(intervals));
      }),
      { numRuns: 300 },
    );
  });

  it("preserves total covered time when normalizing", () => {
    fc.assert(
      fc.property(arbitraryIntervals, (intervals) => {
        expect(totalDuration(normalize(intervals))).toBe(totalDuration(intervals));
      }),
      { numRuns: 300 },
    );
  });

  it("subtracts to something no larger, and never below zero", () => {
    fc.assert(
      fc.property(arbitraryIntervals, arbitraryIntervals, (from, remove) => {
        const result = subtract(from, remove);

        expect(totalDuration(result)).toBeLessThanOrEqual(totalDuration(from));
        expect(totalDuration(result)).toBeGreaterThanOrEqual(0);
      }),
      { numRuns: 300 },
    );
  });

  it("leaves nothing behind when subtracting from itself", () => {
    fc.assert(
      fc.property(arbitraryIntervals, (intervals) => {
        expect(subtract(intervals, intervals)).toEqual([]);
      }),
      { numRuns: 300 },
    );
  });

  it("changes nothing when subtracting the disjoint", () => {
    fc.assert(
      fc.property(arbitraryIntervals, (intervals) => {
        const faraway: Interval[] = [{ start: 1_000_000, end: 2_000_000 }];
        expect(subtract(intervals, faraway)).toEqual(normalize(intervals));
      }),
      { numRuns: 300 },
    );
  });

  it("adds back up: what was removed plus what remains equals what there was", () => {
    fc.assert(
      fc.property(arbitraryIntervals, arbitraryIntervals, (from, remove) => {
        const remaining = subtract(from, remove);
        const removed = subtract(from, remaining);

        expect(totalDuration(remaining) + totalDuration(removed)).toBe(totalDuration(from));
      }),
      { numRuns: 300 },
    );
  });
});
