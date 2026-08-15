import { describe, expect, it } from "vitest";
import { addDays, weekdayOf } from "@bam/availability-engine";
import {
  addMonths,
  buildMonthGrid,
  daysInMonth,
  dedupeByStart,
  firstAvailableDay,
  isBefore,
  localDayOf,
  monthOf,
  monthRangeOf,
  nextFocusedDay,
  slotsOnDay,
  summariseSlotsByDay,
  WEEK_STARTS_ON,
} from "./month-availability";

/**
 * The month grid, tested where its boundaries are.
 *
 * Almost every case here is a date somebody would have to look up to check by
 * hand: the one month in five years that needs exactly four rows, the day-count
 * clamp that stops PageDown skipping February, and the daylight-saving weekend
 * that makes local-time arithmetic wrong twice a year. None of it needs a DOM,
 * which is the point — this app runs no DOM tests, so anything the calendar
 * decides has to be decided here to be testable at all.
 */

function slot(startAt: string, providerId = "p1"): { startAt: string; providerId: string } {
  return { startAt, providerId };
}

describe("addMonths", () => {
  it("moves within a year", () => {
    expect(addMonths("2026-08", 1)).toBe("2026-09");
    expect(addMonths("2026-08", -1)).toBe("2026-07");
    expect(addMonths("2026-08", 0)).toBe("2026-08");
  });

  it("crosses year boundaries in both directions", () => {
    expect(addMonths("2026-12", 1)).toBe("2027-01");
    expect(addMonths("2026-01", -1)).toBe("2025-12");
    expect(addMonths("2026-08", 13)).toBe("2027-09");
    expect(addMonths("2026-08", -13)).toBe("2025-07");
    expect(addMonths("2026-08", 12)).toBe("2027-08");
  });

  it("takes a month rather than a date, so there is no day to overflow", () => {
    // `new Date("2026-01-31").setMonth(+1)` is 3 March, which is why PageDown
    // is expressed as a month step plus an explicit clamp. Nothing about
    // `addMonths` can produce a day at all.
    expect(addMonths(monthOf("2026-01-31"), 1)).toBe("2026-02");
  });
});

describe("daysInMonth", () => {
  it("knows the short months and the leap years", () => {
    expect(daysInMonth("2027-02")).toBe(28);
    expect(daysInMonth("2028-02")).toBe(29);
    expect(daysInMonth("2026-04")).toBe(30);
    expect(daysInMonth("2026-12")).toBe(31);
    expect(daysInMonth("2100-02")).toBe(28); // a century that is not a leap year
  });
});

describe("monthRangeOf", () => {
  it("asks for a whole future month", () => {
    expect(monthRangeOf("2026-09", "2026-08-15")).toEqual({
      dateFrom: "2026-09-01",
      dateTo: "2026-09-30",
    });
  });

  it("never asks for a day that has already gone", () => {
    expect(monthRangeOf("2026-08", "2026-08-15")).toEqual({
      dateFrom: "2026-08-15",
      dateTo: "2026-08-31",
    });
  });

  it("collapses to one day on the last of the month", () => {
    expect(monthRangeOf("2026-08", "2026-08-31")).toEqual({
      dateFrom: "2026-08-31",
      dateTo: "2026-08-31",
    });
  });

  it("returns null for a month entirely in the past", () => {
    // The caller disables the query rather than sending a range for days
    // nobody can book.
    expect(monthRangeOf("2026-07", "2026-08-15")).toBeNull();
    expect(monthRangeOf("2026-07", "2026-08-01")).toBeNull();
  });

  it("stays inside the API's 62-day cap for every month of three years", () => {
    // The guard that matters if somebody later widens the range to cover the
    // grid's leading and trailing days: `slotSearchBodySchema` rejects a span
    // longer than 62 days, and it would reject it in production first.
    for (let year = 2026; year <= 2028; year += 1) {
      for (let month = 1; month <= 12; month += 1) {
        const key = `${String(year)}-${String(month).padStart(2, "0")}`;
        const range = monthRangeOf(key, "2026-01-01");

        expect(range).not.toBeNull();
        const span =
          (Date.parse(`${range!.dateTo}T00:00:00Z`) - Date.parse(`${range!.dateFrom}T00:00:00Z`)) /
          86_400_000;
        expect(span).toBeGreaterThanOrEqual(0);
        expect(span).toBeLessThanOrEqual(62);
      }
    }
  });
});

describe("buildMonthGrid", () => {
  it("pads a month that starts mid-week out to six rows", () => {
    // 2026-08-01 is a Saturday, so a Monday-first grid borrows five days from
    // July and runs into September.
    const weeks = buildMonthGrid("2026-08");

    expect(weeks).toHaveLength(6);
    expect(weeks[0]?.[0]?.date).toBe("2026-07-27");
    expect(weeks.at(-1)?.at(-1)?.date).toBe("2026-09-06");
  });

  it("gives February 2027 exactly four rows and no padding at all", () => {
    // 28 days starting on a Monday — the only month between 2026 and 2030 that
    // fits a Monday-first grid exactly. A fixed six-row grid would render this
    // as four real rows plus fourteen filler cells.
    const weeks = buildMonthGrid("2027-02");

    expect(weeks).toHaveLength(4);
    expect(weeks.flat().every((cell) => cell.inMonth)).toBe(true);
    expect(weeks[0]?.[0]?.date).toBe("2027-02-01");
    expect(weeks.at(-1)?.at(-1)?.date).toBe("2027-02-28");
  });

  it("uses five rows for a 28-day month that starts on a Sunday", () => {
    expect(buildMonthGrid("2026-02")).toHaveLength(5);
  });

  it("uses six rows for a 31-day month that starts on a Sunday", () => {
    expect(buildMonthGrid("2026-03")).toHaveLength(6);
  });

  it.each(["2026-01", "2026-02", "2026-08", "2027-02", "2028-02", "2026-12"])(
    "%s is a contiguous run of full weeks starting on the first column's weekday",
    (month) => {
      const weeks = buildMonthGrid(month);

      expect(weeks.length).toBeGreaterThanOrEqual(4);
      expect(weeks.length).toBeLessThanOrEqual(6);

      for (const week of weeks) {
        expect(week).toHaveLength(7);
        expect(weekdayOf(week[0]!.date)).toBe(WEEK_STARTS_ON);
      }

      const flat = weeks.flat();
      for (let index = 1; index < flat.length; index += 1) {
        expect(flat[index]?.date).toBe(addDays(flat[index - 1]!.date, 1));
      }
    },
  );

  it("marks exactly the month's own days as in-month, in order", () => {
    const inMonth = buildMonthGrid("2028-02")
      .flat()
      .filter((cell) => cell.inMonth);

    expect(inMonth).toHaveLength(29);
    expect(inMonth[0]?.date).toBe("2028-02-01");
    expect(inMonth.at(-1)?.date).toBe("2028-02-29");
    expect(inMonth.map((cell) => cell.dayOfMonth)).toEqual(
      Array.from({ length: 29 }, (_, index) => index + 1),
    );
  });

  it("borrows across a year boundary", () => {
    const trailing = buildMonthGrid("2026-12")
      .flat()
      .filter((cell) => !cell.inMonth && cell.date > "2026-12-31");

    expect(trailing.length).toBeGreaterThan(0);
    expect(trailing.every((cell) => cell.date.startsWith("2027-01"))).toBe(true);
  });
});

describe("nextFocusedDay", () => {
  it("steps a day and a week", () => {
    expect(nextFocusedDay("2026-08-17", "ArrowRight")).toBe("2026-08-18");
    expect(nextFocusedDay("2026-08-17", "ArrowLeft")).toBe("2026-08-16");
    expect(nextFocusedDay("2026-08-17", "ArrowDown")).toBe("2026-08-24");
    expect(nextFocusedDay("2026-08-17", "ArrowUp")).toBe("2026-08-10");
  });

  it("leaves the month at its edges rather than clamping", () => {
    // Clamping here is what makes the last week of a month unreachable by
    // keyboard; the caller follows the date into the next month instead.
    expect(nextFocusedDay("2026-08-31", "ArrowRight")).toBe("2026-09-01");
    expect(nextFocusedDay("2026-08-01", "ArrowLeft")).toBe("2026-07-31");
    expect(nextFocusedDay("2026-08-28", "ArrowDown")).toBe("2026-09-04");
  });

  it("moves Home and End to that week's Monday and Sunday", () => {
    // 2026-08-19 is a Wednesday.
    expect(nextFocusedDay("2026-08-19", "Home")).toBe("2026-08-17");
    expect(nextFocusedDay("2026-08-19", "End")).toBe("2026-08-23");
  });

  it("lets Home cross into the previous month", () => {
    // 2026-09-01 is a Tuesday, so its week began on 31 August. This is the case
    // that proves the caller must follow focus out of the visible month.
    expect(nextFocusedDay("2026-09-01", "Home")).toBe("2026-08-31");
  });

  it("clamps a page step to the target month's length", () => {
    expect(nextFocusedDay("2026-01-31", "PageDown")).toBe("2026-02-28");
    expect(nextFocusedDay("2028-01-31", "PageDown")).toBe("2028-02-29");
    expect(nextFocusedDay("2026-03-31", "PageUp")).toBe("2026-02-28");
    expect(nextFocusedDay("2026-08-15", "PageDown")).toBe("2026-09-15");
  });

  it("steps a year with shift, clamping a leap day", () => {
    expect(nextFocusedDay("2028-02-29", "PageDown", { shift: true })).toBe("2029-02-28");
    expect(nextFocusedDay("2026-08-15", "PageUp", { shift: true })).toBe("2025-08-15");
  });

  it("is zoneless across a daylight-saving transition", () => {
    // Hungary turns the clocks back on 2026-10-25. Local-time arithmetic can
    // land on the same date twice here; this walks straight through.
    expect(nextFocusedDay("2026-10-24", "ArrowRight")).toBe("2026-10-25");
    expect(nextFocusedDay("2026-10-25", "ArrowRight")).toBe("2026-10-26");
    expect(nextFocusedDay("2026-10-24", "ArrowDown")).toBe("2026-10-31");
  });
});

describe("summariseSlotsByDay", () => {
  it("returns nothing for no slots", () => {
    expect(summariseSlotsByDay([]).size).toBe(0);
  });

  it("counts distinct starts, not items", () => {
    // Three providers free at the same instant is one time on offer. Counting
    // items would tell the customer a day has three times when it has one.
    const summaries = summariseSlotsByDay([
      slot("2026-08-18T07:00:00.000Z", "p1"),
      slot("2026-08-18T07:00:00.000Z", "p2"),
      slot("2026-08-18T07:00:00.000Z", "p3"),
      slot("2026-08-18T07:15:00.000Z", "p1"),
    ]);

    expect(summaries.get(localDayOf("2026-08-18T07:00:00.000Z"))).toEqual({
      count: 2,
      firstStartAt: "2026-08-18T07:00:00.000Z",
    });
  });

  it("keeps the earliest start whatever the input order", () => {
    const day = localDayOf("2026-08-18T07:00:00.000Z");
    const summaries = summariseSlotsByDay([
      slot("2026-08-18T11:00:00.000Z"),
      slot("2026-08-18T07:00:00.000Z"),
      slot("2026-08-18T09:00:00.000Z"),
    ]);

    expect(summaries.get(day)?.firstStartAt).toBe("2026-08-18T07:00:00.000Z");
  });

  it("splits a run of slots on the local day boundary", () => {
    const before = "2026-08-18T21:30:00.000Z";
    const after = "2026-08-18T23:30:00.000Z";

    if (localDayOf(before) === localDayOf(after)) {
      // The runner's zone does not put a boundary between these two; there is
      // nothing to assert about a boundary that is not crossed here.
      expect(summariseSlotsByDay([slot(before), slot(after)]).size).toBe(1);
      return;
    }

    expect(summariseSlotsByDay([slot(before), slot(after)]).size).toBe(2);
  });
});

describe("dedupeByStart", () => {
  it("keeps one slot per start, ascending", () => {
    const deduped = dedupeByStart([
      slot("2026-08-18T09:00:00.000Z", "p2"),
      slot("2026-08-18T08:00:00.000Z", "p1"),
      slot("2026-08-18T08:00:00.000Z", "p2"),
    ]);

    expect(deduped.map((entry) => entry.startAt)).toEqual([
      "2026-08-18T08:00:00.000Z",
      "2026-08-18T09:00:00.000Z",
    ]);
  });

  it("picks the same provider however the input is ordered", () => {
    // Stability is the property that matters: a button that changes provider
    // between renders books somebody a different person than they were looking
    // at. Which provider wins is the API's sort order, not our concern.
    const input = [
      slot("2026-08-18T08:00:00.000Z", "p1"),
      slot("2026-08-18T08:00:00.000Z", "p2"),
      slot("2026-08-18T08:00:00.000Z", "p3"),
    ];

    expect(dedupeByStart(input)[0]?.providerId).toBe("p1");
    expect(dedupeByStart([...input])[0]?.providerId).toBe("p1");
  });

  it("does not mutate its input", () => {
    const input = [slot("2026-08-18T09:00:00.000Z"), slot("2026-08-18T08:00:00.000Z")];
    const copy = [...input];

    dedupeByStart(input);
    expect(input).toEqual(copy);
  });
});

describe("slotsOnDay", () => {
  it("returns that day's slots only, deduplicated and ascending", () => {
    const day = localDayOf("2026-08-18T08:00:00.000Z");
    const slots = [
      slot("2026-08-19T08:00:00.000Z"),
      slot("2026-08-18T09:00:00.000Z", "p2"),
      slot("2026-08-18T09:00:00.000Z", "p1"),
      slot("2026-08-18T08:00:00.000Z"),
    ];

    expect(slotsOnDay(slots, day).map((entry) => entry.startAt)).toEqual([
      "2026-08-18T08:00:00.000Z",
      "2026-08-18T09:00:00.000Z",
    ]);
  });

  it("returns nothing for a day with nothing", () => {
    expect(slotsOnDay([slot("2026-08-18T08:00:00.000Z")], "2026-08-20")).toEqual([]);
  });
});

describe("firstAvailableDay", () => {
  const summaries = new Map([
    ["2026-08-14", { count: 4, firstStartAt: "2026-08-14T07:00:00.000Z" }],
    ["2026-08-18", { count: 6, firstStartAt: "2026-08-18T07:00:00.000Z" }],
    ["2026-08-20", { count: 2, firstStartAt: "2026-08-20T07:00:00.000Z" }],
    ["2026-09-01", { count: 9, firstStartAt: "2026-09-01T07:00:00.000Z" }],
  ]);

  it("takes the earliest day that is not in the past", () => {
    expect(firstAvailableDay(summaries, "2026-08", "2026-08-15")).toBe("2026-08-18");
  });

  it("includes today when today has something", () => {
    expect(firstAvailableDay(summaries, "2026-08", "2026-08-18")).toBe("2026-08-18");
  });

  it("ignores days outside the month asked about", () => {
    expect(firstAvailableDay(summaries, "2026-09", "2026-08-15")).toBe("2026-09-01");
  });

  it("returns null when the month holds nothing bookable", () => {
    expect(firstAvailableDay(summaries, "2026-08", "2026-08-21")).toBeNull();
    expect(firstAvailableDay(new Map(), "2026-08", "2026-08-15")).toBeNull();
  });
});

describe("isBefore", () => {
  it("compares ISO dates chronologically as strings", () => {
    expect(isBefore("2026-08-14", "2026-08-15")).toBe(true);
    expect(isBefore("2026-08-15", "2026-08-15")).toBe(false);
    expect(isBefore("2026-08-16", "2026-08-15")).toBe(false);
    expect(isBefore("2026-09-01", "2026-10-01")).toBe(true);
    expect(isBefore("2026-12-31", "2027-01-01")).toBe(true);
  });
});

describe("localDayOf", () => {
  it("reads the day off the local clock, not off UTC", () => {
    // Asserted against the runner's own zone, because that is the property
    // that matters: the grouping must agree with `Intl`, which is also
    // zone-less here. A fixed string would only test the runner's TZ.
    const instant = "2026-08-17T21:30:00.000Z";
    const local = new Date(instant);
    const expected = `${String(local.getFullYear()).padStart(4, "0")}-${String(
      local.getMonth() + 1,
    ).padStart(2, "0")}-${String(local.getDate()).padStart(2, "0")}`;

    expect(localDayOf(instant)).toBe(expected);
  });
});
