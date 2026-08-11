import { describe, expect, it } from "vitest";

import { DAYPARTS, instantFor, resolveDateExpression } from "./dates.js";

/**
 * tech-impl §24. The whole reason this resolver exists rather than asking the
 * model for an ISO instant is the last two describes in this file: a wall-clock
 * reading is not an instant until a zone has been applied to it, and on two
 * mornings a year the answer is not a simple one.
 */

const ZONE = "Europe/Budapest";
/** A Monday. 2026-08-10 is a Monday, which makes the weekday maths readable. */
const MONDAY = new Date("2026-08-10T09:00:00Z");

function range(expression: string, now = MONDAY) {
  const result = resolveDateExpression({ dateExpression: expression, timezone: ZONE, now });
  if (!result.ok) throw new Error(`unresolved: ${expression}`);
  return result.range;
}

describe("relative days", () => {
  it("reads today, tomorrow and the day after, in both languages", () => {
    expect(range("today")).toMatchObject({ dateFrom: "2026-08-10", dateTo: "2026-08-10" });
    expect(range("ma")).toMatchObject({ dateFrom: "2026-08-10" });
    expect(range("tomorrow")).toMatchObject({ dateFrom: "2026-08-11", dateTo: "2026-08-11" });
    expect(range("holnap")).toMatchObject({ dateFrom: "2026-08-11" });
    expect(range("holnapután")).toMatchObject({ dateFrom: "2026-08-12" });
  });

  it("takes an explicit date at its word", () => {
    expect(range("2026-09-03")).toMatchObject({ dateFrom: "2026-09-03", dateTo: "2026-09-03" });
  });
});

describe("weekdays", () => {
  it("without a marker, means the next one strictly after today", () => {
    // Today is Monday. "on Tuesday" is tomorrow.
    expect(range("on Tuesday")).toMatchObject({
      dateFrom: "2026-08-11",
      assumption: "UPCOMING_ASSUMED",
    });
    // "on Monday" is a week today, not today — somebody who means today says so.
    expect(range("on Monday")).toMatchObject({ dateFrom: "2026-08-17" });
  });

  it("with a marker, means the following week", () => {
    // "jövő kedden" is the Tuesday of next week, not tomorrow.
    expect(range("jövő kedden")).toMatchObject({
      dateFrom: "2026-08-18",
      assumption: "NEXT_WEEK_ASSUMED",
    });
    expect(range("next Tuesday")).toMatchObject({ dateFrom: "2026-08-18" });
  });

  it("survives a customer typing without accents", () => {
    expect(range("jovo csutortok")).toMatchObject({ dateFrom: "2026-08-20" });
    expect(range("csütörtökön")).toMatchObject({ dateFrom: "2026-08-13" });
  });

  it("reads a whole week", () => {
    expect(range("next week")).toMatchObject({ dateFrom: "2026-08-17", dateTo: "2026-08-23" });
  });
});

describe("times of day", () => {
  function withTime(dateExpression: string, timeExpression: string) {
    const result = resolveDateExpression({
      dateExpression,
      timeExpression,
      timezone: ZONE,
      now: MONDAY,
    });
    if (!result.ok) throw new Error("unresolved");
    return result.range;
  }

  it("reads dayparts in both languages", () => {
    expect(withTime("tomorrow", "délután")).toMatchObject({
      timeFrom: DAYPARTS.afternoon.from,
      timeTo: DAYPARTS.afternoon.to,
    });
    expect(withTime("tomorrow", "in the morning")).toMatchObject({
      timeFrom: DAYPARTS.morning.from,
    });
  });

  it("widens an exact time into a window", () => {
    // "at 14:00" is a preference, not a demand for one instant.
    const result = withTime("tomorrow", "14:00");
    expect(result.timeFrom).toBe(13 * 60 + 15);
    expect(result.timeTo).toBe(14 * 60 + 45);
  });

  it("reads a bare afternoon hour as the afternoon", () => {
    // No clinic in this product opens at five in the morning, and the customer
    // sees the absolute time before confirming either way.
    expect(withTime("tomorrow", "5 óra")).toMatchObject({ timeFrom: 16 * 60 + 15 });
  });

  it("refuses a time it cannot read rather than guessing", () => {
    const result = resolveDateExpression({
      dateExpression: "tomorrow",
      timeExpression: "whenever suits you",
      timezone: ZONE,
      now: MONDAY,
    });

    expect(result).toMatchObject({ ok: false, reason: "UNRECOGNISED_TIME" });
  });
});

describe("no date given", () => {
  it("looks at the default window rather than failing", () => {
    const result = resolveDateExpression({ timezone: ZONE, now: MONDAY });

    expect(result).toMatchObject({
      ok: true,
      range: { dateFrom: "2026-08-10", dateTo: "2026-08-24", assumption: "DEFAULT_WINDOW" },
    });
  });

  it("keeps a time preference that arrived without a date", () => {
    const result = resolveDateExpression({
      timeExpression: "délután",
      timezone: ZONE,
      now: MONDAY,
    });

    expect(result.ok && result.range.timeFrom).toBe(DAYPARTS.afternoon.from);
  });
});

describe("refusals", () => {
  it("refuses a date it cannot read", () => {
    expect(
      resolveDateExpression({ dateExpression: "sometime soonish", timezone: ZONE, now: MONDAY }),
    ).toMatchObject({ ok: false, reason: "UNRECOGNISED_DATE" });
  });
});

describe("the resolver is anchored in the conversation's zone, not the server's", () => {
  it("late-evening UTC is already tomorrow in Budapest", () => {
    // 23:30Z on the 10th is 01:30 on the 11th in Budapest. "Today" must be the
    // 11th for a customer standing in Budapest.
    const late = new Date("2026-08-10T23:30:00Z");

    expect(range("today", late)).toMatchObject({ dateFrom: "2026-08-11" });
  });
});

describe("daylight saving", () => {
  it("reports a reading the clocks jumped over", () => {
    // Hungary springs forward at 02:00 on 2026-03-29: 02:30 does not exist.
    const result = instantFor({ date: "2026-03-29", minuteOfDay: 2 * 60 + 30, timezone: ZONE });

    expect(result.resolution).toBe("skipped");
    // Snapped forward to the first reading that does exist — 03:00 local, which
    // is 01:00 UTC.
    expect(new Date(result.epochMs).toISOString()).toBe("2026-03-29T01:00:00.000Z");
  });

  it("reports a reading that happens twice", () => {
    // Hungary falls back at 03:00 on 2026-10-25: 02:30 happens twice.
    const result = instantFor({ date: "2026-10-25", minuteOfDay: 2 * 60 + 30, timezone: ZONE });

    expect(result.resolution).toBe("ambiguous");
    // The earlier instant wins, which is the one a customer arriving "at 2:30"
    // would experience first.
    expect(new Date(result.epochMs).toISOString()).toBe("2026-10-25T00:30:00.000Z");
  });

  it("is an ordinary reading on an ordinary day", () => {
    const result = instantFor({ date: "2026-08-11", minuteOfDay: 14 * 60, timezone: ZONE });

    expect(result.resolution).toBe("exact");
    expect(new Date(result.epochMs).toISOString()).toBe("2026-08-11T12:00:00.000Z");
  });

  it("2pm stays 2pm across the transition, which adding an offset would not", () => {
    // The same wall-clock reading either side of the October change. An offset
    // added by hand is right for one of these and an hour wrong for the other.
    const summer = instantFor({ date: "2026-10-24", minuteOfDay: 14 * 60, timezone: ZONE });
    const winter = instantFor({ date: "2026-10-26", minuteOfDay: 14 * 60, timezone: ZONE });

    expect(new Date(summer.epochMs).toISOString()).toBe("2026-10-24T12:00:00.000Z");
    expect(new Date(winter.epochMs).toISOString()).toBe("2026-10-26T13:00:00.000Z");
  });
});
