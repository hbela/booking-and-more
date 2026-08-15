import { describe, expect, it } from "vitest";
import { addDaysToDateOnly, localDayOf, nextAvailableDays } from "./next-available";

/**
 * The empty-day suggestion, tested where the timezone traps live.
 *
 * Every case that matters here is a boundary: the day arithmetic across a
 * daylight-saving change, and the instant → calendar-day grouping for an
 * evening appointment, which is a different day in UTC than it is on the wall
 * the customer is reading.
 */

describe("addDaysToDateOnly", () => {
  it("advances a date", () => {
    expect(addDaysToDateOnly("2026-08-17", 1)).toBe("2026-08-18");
    expect(addDaysToDateOnly("2026-08-17", 14)).toBe("2026-08-31");
  });

  it("crosses month and year ends", () => {
    expect(addDaysToDateOnly("2026-08-31", 1)).toBe("2026-09-01");
    expect(addDaysToDateOnly("2026-12-28", 14)).toBe("2027-01-11");
  });

  it("counts calendar days across a daylight-saving change", () => {
    // Europe/Budapest turns the clocks back on 2026-10-25. A local-time
    // implementation can land on the same date twice here; a UTC one cannot.
    expect(addDaysToDateOnly("2026-10-24", 1)).toBe("2026-10-25");
    expect(addDaysToDateOnly("2026-10-25", 1)).toBe("2026-10-26");
    expect(addDaysToDateOnly("2026-10-24", 7)).toBe("2026-10-31");
  });

  it("handles a leap day", () => {
    expect(addDaysToDateOnly("2028-02-28", 1)).toBe("2028-02-29");
  });
});

describe("localDayOf", () => {
  it("reads the day off the local clock, not off UTC", () => {
    // Written against whatever zone the test runs in, because that is the
    // property that matters: the grouping must agree with Intl, which is also
    // zone-less. Asserting a fixed string would only test the runner's TZ.
    const instant = "2026-08-17T21:30:00.000Z";
    const local = new Date(instant);
    const expected = `${String(local.getFullYear()).padStart(4, "0")}-${String(
      local.getMonth() + 1,
    ).padStart(2, "0")}-${String(local.getDate()).padStart(2, "0")}`;

    expect(localDayOf(instant)).toBe(expected);
  });
});

describe("nextAvailableDays", () => {
  function slot(startAt: string): { startAt: string } {
    return { startAt };
  }

  it("returns nothing for no slots", () => {
    expect(nextAvailableDays([])).toEqual([]);
  });

  it("groups by day, counts, and keeps the earliest start", () => {
    const days = nextAvailableDays([
      slot("2026-08-18T07:00:00.000Z"),
      slot("2026-08-18T07:15:00.000Z"),
      slot("2026-08-19T09:00:00.000Z"),
    ]);

    expect(days).toHaveLength(2);
    expect(days[0]).toMatchObject({ count: 2, firstStartAt: "2026-08-18T07:00:00.000Z" });
    expect(days[1]).toMatchObject({ count: 1, firstStartAt: "2026-08-19T09:00:00.000Z" });
    expect(days[0]?.date).toBe(localDayOf("2026-08-18T07:00:00.000Z"));
  });

  it("orders days earliest first and takes the earliest start whatever the input order", () => {
    const days = nextAvailableDays([
      slot("2026-08-20T10:00:00.000Z"),
      slot("2026-08-18T11:00:00.000Z"),
      slot("2026-08-18T08:00:00.000Z"),
    ]);

    expect(days.map((entry) => entry.firstStartAt)).toEqual([
      "2026-08-18T08:00:00.000Z",
      "2026-08-20T10:00:00.000Z",
    ]);
  });

  it("offers at most the limit, keeping the nearest days", () => {
    const days = nextAvailableDays(
      [
        slot("2026-08-18T08:00:00.000Z"),
        slot("2026-08-19T08:00:00.000Z"),
        slot("2026-08-20T08:00:00.000Z"),
        slot("2026-08-21T08:00:00.000Z"),
      ],
      3,
    );

    expect(days).toHaveLength(3);
    expect(days.at(-1)?.date).toBe(localDayOf("2026-08-20T08:00:00.000Z"));
  });

  it("splits a run of slots on the local day boundary", () => {
    // Two instants an hour apart across local midnight must land in different
    // groups — the heading has to match the time printed beside it.
    const before = "2026-08-18T21:30:00.000Z";
    const after = "2026-08-18T23:30:00.000Z";

    if (localDayOf(before) === localDayOf(after)) {
      // Same local day in this runner's zone: nothing to assert about a
      // boundary that is not crossed here.
      expect(nextAvailableDays([slot(before), slot(after)])).toHaveLength(1);
      return;
    }

    expect(nextAvailableDays([slot(before), slot(after)])).toHaveLength(2);
  });
});
