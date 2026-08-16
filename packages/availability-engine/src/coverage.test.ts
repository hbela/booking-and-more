import { describe, expect, it } from "vitest";
import { findUncoveredAppointments, UncoveredReasons } from "./engine.js";
import type { CoverageQuery, DateTimePeriod, TimePeriod } from "./index.js";

/**
 * docs/phase-3-4-schedule-conflicts.md §2.1–§2.2.
 *
 * Same conventions as engine.test.ts next door: everything is written and
 * asserted in Budapest local time, because that is how a clinic thinks about its
 * own diary, and the fixtures compute their UTC offsets by hand so they do not
 * depend on the code under test.
 */

const BUDAPEST = "Europe/Budapest";

/** A Monday, comfortably away from any transition. */
const MONDAY = "2026-07-27";
const TUESDAY = "2026-07-28";

/** An absolute period from two local wall-clock times on a date. */
function local(date: string, startTime: string, endTime: string): DateTimePeriod {
  const at = (time: string): string => {
    const summer = date >= "2026-03-29" && date < "2026-10-25";
    const [hour, minute] = time.split(":").map(Number);
    const utcHour = (hour ?? 0) - (summer ? 2 : 1);
    return new Date(
      Date.UTC(2026, Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)), utcHour, minute ?? 0),
    ).toISOString();
  };

  return { startAt: at(startTime), endAt: at(endTime) };
}

/** One appointment, by local wall-clock time. */
function appointment(id: string, date: string, startTime: string, endTime: string) {
  return { id, ...local(date, startTime, endTime) };
}

const MONDAY_NINE_TO_FIVE: TimePeriod = { weekday: 1, startTime: "09:00", endTime: "17:00" };

function query(overrides: Partial<CoverageQuery> = {}): CoverageQuery {
  return {
    timezone: BUDAPEST,
    workingPeriods: [MONDAY_NINE_TO_FIVE],
    additionalPeriods: [],
    unavailablePeriods: [],
    appointments: [appointment("bk_1", MONDAY, "10:00", "11:00")],
    ...overrides,
  };
}

describe("findUncoveredAppointments", () => {
  it("says nothing about an appointment inside the hours", () => {
    expect(findUncoveredAppointments(query())).toEqual([]);
  });

  it("has nothing to say about no appointments", () => {
    expect(findUncoveredAppointments(query({ appointments: [] }))).toEqual([]);
  });

  it("finds one left behind when its weekday is removed", () => {
    // The question that started this: the provider drops Mondays while a Monday
    // booking exists.
    const found = findUncoveredAppointments(query({ workingPeriods: [] }));

    expect(found).toEqual([{ id: "bk_1", reason: UncoveredReasons.OUTSIDE_WORKING_HOURS }]);
  });

  it("finds one the hours were narrowed under", () => {
    const found = findUncoveredAppointments(
      query({ workingPeriods: [{ weekday: 1, startTime: "13:00", endTime: "17:00" }] }),
    );

    expect(found).toHaveLength(1);
  });

  it("finds one that only partly survives the narrowing", () => {
    // 10:00–11:00 against hours ending at 10:30. Half-covered is not covered:
    // the provider leaves halfway through the appointment.
    const found = findUncoveredAppointments(
      query({ workingPeriods: [{ weekday: 1, startTime: "09:00", endTime: "10:30" }] }),
    );

    expect(found).toEqual([{ id: "bk_1", reason: UncoveredReasons.OUTSIDE_WORKING_HOURS }]);
  });

  it("reports only the ones actually stranded", () => {
    const found = findUncoveredAppointments(
      query({
        workingPeriods: [{ weekday: 1, startTime: "09:00", endTime: "12:00" }],
        appointments: [
          appointment("keeps", MONDAY, "10:00", "11:00"),
          appointment("stranded", MONDAY, "14:00", "15:00"),
        ],
      }),
    );

    expect(found.map((entry) => entry.id)).toEqual(["stranded"]);
  });

  it("distinguishes time off from hours that never covered it", () => {
    // Both are "the provider will not be there", and they are different
    // sentences to read: one is usually deliberate, the other usually a mistake.
    const blocked = findUncoveredAppointments(
      query({ unavailablePeriods: [local(MONDAY, "09:00", "12:00")] }),
    );

    expect(blocked).toEqual([{ id: "bk_1", reason: UncoveredReasons.BLOCKED_BY_EXCEPTION }]);
  });

  it("prefers the more fundamental reason when both apply", () => {
    // Outside the hours *and* under a closure. "You do not work then" is the
    // fact that has to be dealt with first.
    const found = findUncoveredAppointments(
      query({
        workingPeriods: [{ weekday: 1, startTime: "09:00", endTime: "10:30" }],
        unavailablePeriods: [local(MONDAY, "09:00", "12:00")],
      }),
    );

    expect(found[0]?.reason).toBe(UncoveredReasons.OUTSIDE_WORKING_HOURS);
  });

  it("counts a one-off opening as cover, exactly as the search does", () => {
    const found = findUncoveredAppointments(
      query({
        workingPeriods: [],
        additionalPeriods: [local(MONDAY, "09:00", "12:00")],
      }),
    );

    expect(found).toEqual([]);
  });

  it("ignores buffers", () => {
    // §2.2. The appointment ends exactly at closing; a service with an
    // after-buffer could never have been booked here, but the provider *is*
    // present for the appointment, and warning about the cleanup is how a
    // dialog gets clicked through unread.
    const found = findUncoveredAppointments(
      query({ appointments: [appointment("bk_1", MONDAY, "16:00", "17:00")] }),
    );

    expect(found).toEqual([]);
  });

  it("treats a back-to-back appointment at the opening bell as covered", () => {
    const found = findUncoveredAppointments(
      query({ appointments: [appointment("bk_1", MONDAY, "09:00", "10:00")] }),
    );

    expect(found).toEqual([]);
  });

  describe("dates the period is valid for", () => {
    it("strands an appointment before the period starts applying", () => {
      const found = findUncoveredAppointments(
        query({ workingPeriods: [{ ...MONDAY_NINE_TO_FIVE, validFrom: "2026-08-01" }] }),
      );

      expect(found).toHaveLength(1);
    });

    it("leaves one alone that falls inside the validity window", () => {
      const found = findUncoveredAppointments(
        query({
          workingPeriods: [
            { ...MONDAY_NINE_TO_FIVE, validFrom: "2026-07-01", validUntil: "2026-08-01" },
          ],
        }),
      );

      expect(found).toEqual([]);
    });
  });

  describe("the awkward zones", () => {
    it("keeps a wall-clock schedule wall-clock across a spring-forward day", () => {
      // 2026-03-29 is the Sunday the clocks go forward in Budapest. 09:00–17:00
      // is seven hours that day, not eight, and a 16:30 appointment is still
      // inside it — the §13.4 trap, asked from the other direction.
      const found = findUncoveredAppointments({
        timezone: BUDAPEST,
        workingPeriods: [{ weekday: 7, startTime: "09:00", endTime: "17:00" }],
        additionalPeriods: [],
        unavailablePeriods: [],
        appointments: [appointment("bk_dst", "2026-03-29", "16:30", "17:00")],
      });

      expect(found).toEqual([]);
    });

    it("follows a night shift into the next calendar day", () => {
      // 22:00–02:00 on Monday is a late shift, and the 00:30 appointment it
      // covers falls on Tuesday. Judging it by Tuesday's periods would strand a
      // booking that is perfectly well covered.
      const found = findUncoveredAppointments({
        timezone: BUDAPEST,
        workingPeriods: [{ weekday: 1, startTime: "22:00", endTime: "02:00" }],
        additionalPeriods: [],
        unavailablePeriods: [],
        appointments: [appointment("bk_night", TUESDAY, "00:30", "01:30")],
      });

      expect(found).toEqual([]);
    });

    it("reads the schedule in the zone it was written in", () => {
      // One pair of instants, judged against the same written hours in two
      // zones. 09:30–10:00 Budapest is 08:30–09:00 in London, which "09:00–17:00"
      // does not cover. A schedule is wall-clock (rule 13), so the zone it is
      // read in decides — and a chain with a branch across a border is exactly
      // where assuming one would go wrong.
      const budapestMorning = appointment("bk_zone", MONDAY, "09:30", "10:00");

      expect(findUncoveredAppointments(query({ appointments: [budapestMorning] }))).toEqual([]);

      expect(
        findUncoveredAppointments(
          query({ appointments: [budapestMorning], timezone: "Europe/London" }),
        ),
      ).toEqual([{ id: "bk_zone", reason: UncoveredReasons.OUTSIDE_WORKING_HOURS }]);
    });
  });

  it("refuses an appointment whose span cannot be parsed", () => {
    // A caller bug, and loud on purpose: the quiet alternative is reporting it
    // uncovered and a clinic cancelling a real appointment over it.
    expect(() =>
      findUncoveredAppointments(
        query({ appointments: [{ id: "bad", startAt: "not a date", endAt: "also not" }] }),
      ),
    ).toThrow(/bad/u);
  });
});
