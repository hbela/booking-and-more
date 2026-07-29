import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  addDays,
  dateOnlyAt,
  eachDate,
  offsetAt,
  parseTimeOfDay,
  resolveWallClock,
  toWallClock,
  wallClockToEpochMs,
  weekdayOf,
  type WallClock,
} from "./zone.js";

/**
 * The foundation everything else stands on. If these are wrong, every slot the
 * engine produces is wrong by an hour twice a year and nobody notices until a
 * customer arrives to a locked door.
 *
 * Budapest is the pilot zone (CET/CEST). EU transitions happen at 01:00 UTC:
 *
 *   2026-03-29  clocks go 02:00 → 03:00, so 02:00–02:59 local never happens
 *   2026-10-25  clocks go 03:00 → 02:00, so 02:00–02:59 local happens twice
 */

const BUDAPEST = "Europe/Budapest";

function wall(year: number, month: number, day: number, hour: number, minute = 0): WallClock {
  return { year, month, day, hour, minute };
}

function iso(epochMs: number): string {
  return new Date(epochMs).toISOString();
}

describe("toWallClock", () => {
  it("reads the local clock, not UTC", () => {
    // Winter: Budapest is UTC+1.
    expect(toWallClock(Date.parse("2026-01-15T08:00:00Z"), BUDAPEST)).toEqual(
      wall(2026, 1, 15, 9, 0),
    );

    // Summer: UTC+2.
    expect(toWallClock(Date.parse("2026-07-15T08:00:00Z"), BUDAPEST)).toEqual(
      wall(2026, 7, 15, 10, 0),
    );
  });

  it("crosses a date boundary in the local zone, not the UTC one", () => {
    // 23:30 UTC is already tomorrow in Budapest.
    expect(toWallClock(Date.parse("2026-01-15T23:30:00Z"), BUDAPEST)).toEqual(
      wall(2026, 1, 16, 0, 30),
    );
  });
});

describe("offsetAt", () => {
  it("reports standard and summer offsets", () => {
    expect(offsetAt(Date.parse("2026-01-15T12:00:00Z"), BUDAPEST)).toBe(3_600_000);
    expect(offsetAt(Date.parse("2026-07-15T12:00:00Z"), BUDAPEST)).toBe(7_200_000);
  });

  it("handles zones west of Greenwich and half-hour offsets", () => {
    expect(offsetAt(Date.parse("2026-01-15T12:00:00Z"), "America/New_York")).toBe(-18_000_000);
    expect(offsetAt(Date.parse("2026-01-15T12:00:00Z"), "Asia/Kolkata")).toBe(19_800_000);
  });
});

describe("resolveWallClock", () => {
  it("round-trips an ordinary reading", () => {
    const resolved = resolveWallClock(wall(2026, 6, 10, 9, 30), BUDAPEST);

    expect(resolved.resolution).toBe("exact");
    expect(iso(resolved.epochMs)).toBe("2026-06-10T07:30:00.000Z");
    expect(toWallClock(resolved.epochMs, BUDAPEST)).toEqual(wall(2026, 6, 10, 9, 30));
  });

  it("keeps 09:00 at 09:00 across a spring-forward day", () => {
    // The point of §13.4: a clinic open from 09:00 is open from 09:00 on the
    // day the clocks change too. The UTC instant moves; the appointment does
    // not.
    const before = resolveWallClock(wall(2026, 3, 28, 9, 0), BUDAPEST);
    const during = resolveWallClock(wall(2026, 3, 29, 9, 0), BUDAPEST);

    expect(iso(before.epochMs)).toBe("2026-03-28T08:00:00.000Z");
    expect(iso(during.epochMs)).toBe("2026-03-29T07:00:00.000Z");
  });

  it("snaps a reading the clocks jumped over to the first instant that exists", () => {
    const resolved = resolveWallClock(wall(2026, 3, 29, 2, 30), BUDAPEST);

    expect(resolved.resolution).toBe("skipped");
    // 03:00 local, the first moment after the gap.
    expect(iso(resolved.epochMs)).toBe("2026-03-29T01:00:00.000Z");
    expect(toWallClock(resolved.epochMs, BUDAPEST)).toEqual(wall(2026, 3, 29, 3, 0));
  });

  it("takes the earlier instant when a reading happens twice", () => {
    const resolved = resolveWallClock(wall(2026, 10, 25, 2, 30), BUDAPEST);

    expect(resolved.resolution).toBe("ambiguous");
    // Two instants read 02:30 that morning: 00:30Z (still CEST) and 01:30Z
    // (CET). The earlier one wins, so a working day does not start an hour late.
    expect(iso(resolved.epochMs)).toBe("2026-10-25T00:30:00.000Z");
    expect(iso(resolved.epochMs + 3_600_000)).toBe("2026-10-25T01:30:00.000Z");
    expect(toWallClock(resolved.epochMs + 3_600_000, BUDAPEST)).toEqual(wall(2026, 10, 25, 2, 30));
  });

  it("reports readings just outside the transition as exact", () => {
    expect(resolveWallClock(wall(2026, 3, 29, 1, 59), BUDAPEST).resolution).toBe("exact");
    expect(resolveWallClock(wall(2026, 3, 29, 3, 0), BUDAPEST).resolution).toBe("exact");
    expect(resolveWallClock(wall(2026, 10, 25, 1, 59), BUDAPEST).resolution).toBe("exact");
    expect(resolveWallClock(wall(2026, 10, 25, 3, 0), BUDAPEST).resolution).toBe("exact");
  });

  it("handles a half-hour transition", () => {
    // Lord Howe Island shifts by 30 minutes, which is why the gap search walks
    // forward instead of assuming an hour.
    const resolved = resolveWallClock(wall(2026, 10, 4, 2, 15), "Australia/Lord_Howe");

    expect(resolved.resolution).toBe("skipped");
    expect(toWallClock(resolved.epochMs, "Australia/Lord_Howe")).toEqual(wall(2026, 10, 4, 2, 30));
  });

  it("handles a southern-hemisphere zone, where the transitions are reversed", () => {
    expect(resolveWallClock(wall(2026, 1, 15, 12, 0), "Pacific/Auckland").resolution).toBe("exact");
    expect(offsetAt(Date.parse("2026-01-15T00:00:00Z"), "Pacific/Auckland")).toBe(46_800_000);
  });

  it("agrees with itself in both directions, for any instant in any of these zones", () => {
    // The property that matters: reading the clock and then resolving that
    // reading must land back on the same instant — except inside a fall-back
    // hour, where two instants share a reading and the earlier is chosen by
    // design.
    fc.assert(
      fc.property(
        fc.integer({ min: Date.UTC(2024, 0, 1), max: Date.UTC(2030, 0, 1) }),
        fc.constantFrom(
          BUDAPEST,
          "UTC",
          "America/New_York",
          "Asia/Kolkata",
          "Pacific/Auckland",
          "Australia/Lord_Howe",
          "America/Sao_Paulo",
        ),
        (rawMs, zone) => {
          const epochMs = Math.floor(rawMs / 60_000) * 60_000;
          const reading = toWallClock(epochMs, zone);
          const resolved = resolveWallClock(reading, zone);

          // Whatever instant came back must read the same on the clock.
          expect(toWallClock(resolved.epochMs, zone)).toEqual(reading);

          // And it is either the instant we started from, or the earlier of the
          // two that share this reading.
          expect(resolved.epochMs === epochMs || resolved.epochMs === epochMs - 3_600_000).toBe(
            true,
          );
        },
      ),
      { numRuns: 500 },
    );
  });
});

describe("calendar helpers", () => {
  it("adds days across a month, a year and a leap day", () => {
    expect(addDays("2026-01-31", 1)).toBe("2026-02-01");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });

  it("adds a day across a DST boundary, because a calendar day is not 24 hours", () => {
    expect(addDays("2026-03-28", 1)).toBe("2026-03-29");
    expect(addDays("2026-10-24", 1)).toBe("2026-10-25");
  });

  it("numbers weekdays from Monday", () => {
    expect(weekdayOf("2026-07-27")).toBe(1); // Monday
    expect(weekdayOf("2026-08-02")).toBe(7); // Sunday
  });

  it("enumerates an inclusive range", () => {
    expect(eachDate("2026-07-27", "2026-07-30")).toEqual([
      "2026-07-27",
      "2026-07-28",
      "2026-07-29",
      "2026-07-30",
    ]);
    expect(eachDate("2026-07-27", "2026-07-27")).toEqual(["2026-07-27"]);
    expect(eachDate("2026-07-28", "2026-07-27")).toEqual([]);
  });

  it("refuses a range long enough to be a bug", () => {
    expect(() => eachDate("2026-01-01", "2046-01-01")).toThrow(/longer than ten years/);
  });

  it("reports the calendar date in the zone, not in UTC", () => {
    expect(dateOnlyAt(Date.parse("2026-01-15T23:30:00Z"), BUDAPEST)).toBe("2026-01-16");
    expect(dateOnlyAt(Date.parse("2026-01-15T23:30:00Z"), "UTC")).toBe("2026-01-15");
  });
});

describe("parseTimeOfDay", () => {
  it("converts HH:mm to minutes since midnight", () => {
    expect(parseTimeOfDay("00:00")).toBe(0);
    expect(parseTimeOfDay("09:30")).toBe(570);
    expect(parseTimeOfDay("23:59")).toBe(1439);
  });

  it("accepts 24:00 as end-of-day, which a period running to midnight needs", () => {
    expect(parseTimeOfDay("24:00")).toBe(1440);
  });

  it("rejects anything else", () => {
    for (const bad of ["9:30", "24:01", "25:00", "09:60", "", "noon"]) {
      expect(() => parseTimeOfDay(bad), bad).toThrow();
    }
  });
});

describe("wallClockToEpochMs", () => {
  it("is the resolution-free shorthand", () => {
    expect(wallClockToEpochMs(wall(2026, 6, 10, 9, 30), BUDAPEST)).toBe(
      resolveWallClock(wall(2026, 6, 10, 9, 30), BUDAPEST).epochMs,
    );
  });
});
