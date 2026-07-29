import { describe, expect, it } from "vitest";
import { generateSlots, hasAvailability } from "./engine.js";
import type { AvailabilityQuery, AvailableSlot, DateTimePeriod, TimePeriod } from "./types.js";

/**
 * The fifteen cases tech-impl §13.5 requires, plus the boundaries around them.
 *
 * Everything is expressed in Budapest local time, because that is how a clinic
 * thinks about its own diary, and asserted as local times too — a test that
 * asserts UTC instants passes just as happily when the zone handling is wrong.
 */

const BUDAPEST = "Europe/Budapest";

/** A Monday, comfortably away from any transition. */
const MONDAY = "2026-07-27";

function query(overrides: Partial<AvailabilityQuery> = {}): AvailabilityQuery {
  return {
    providerId: "prv_1",
    serviceDurationMinutes: 60,
    bufferBeforeMinutes: 0,
    bufferAfterMinutes: 0,
    dateFrom: MONDAY,
    dateTo: MONDAY,
    timezone: BUDAPEST,
    slotIntervalMinutes: 60,
    workingPeriods: [{ weekday: 1, startTime: "09:00", endTime: "12:00" }],
    additionalPeriods: [],
    unavailablePeriods: [],
    bookings: [],
    activeHolds: [],
    externalBusyPeriods: [],
    minimumNoticeMinutes: 0,
    maximumAdvanceDays: 365,
    // Well before the range, so notice and advance windows never interfere
    // unless a test sets out to exercise them.
    now: "2026-07-01T00:00:00Z",
    ...overrides,
  };
}

/** Local `HH:mm` of each slot start — how a person reads a diary. */
function localStarts(slots: AvailableSlot[], timeZone = BUDAPEST): string[] {
  return slots.map((slot) =>
    new Intl.DateTimeFormat("en-GB", {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(new Date(slot.startAt)),
  );
}

/** An absolute period from two local wall-clock times on a date. */
function local(date: string, startTime: string, endTime: string): DateTimePeriod {
  const at = (time: string): string => {
    // Budapest is UTC+2 in July, +1 in January. Written out rather than
    // computed, so the fixtures do not depend on the code under test.
    const summer = date >= "2026-03-29" && date < "2026-10-25";
    const [hour, minute] = time.split(":").map(Number);
    const utcHour = (hour ?? 0) - (summer ? 2 : 1);
    return new Date(
      Date.UTC(2026, Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)), utcHour, minute ?? 0),
    ).toISOString();
  };

  return { startAt: at(startTime), endAt: at(endTime) };
}

describe("working periods", () => {
  it("offers slots across a simple morning", () => {
    expect(localStarts(generateSlots(query()))).toEqual(["09:00", "10:00", "11:00"]);
  });

  it("offers nothing when there are no working periods at all", () => {
    expect(generateSlots(query({ workingPeriods: [] }))).toEqual([]);
    expect(hasAvailability(query({ workingPeriods: [] }))).toBe(false);
  });

  it("ignores periods for other weekdays", () => {
    // Tuesday's hours must not leak into Monday.
    const slots = generateSlots(
      query({ workingPeriods: [{ weekday: 2, startTime: "09:00", endTime: "17:00" }] }),
    );

    expect(slots).toEqual([]);
  });

  it("honours a period's validity window", () => {
    const period: TimePeriod = {
      weekday: 1,
      startTime: "09:00",
      endTime: "12:00",
      validFrom: "2026-08-01",
    };

    expect(generateSlots(query({ workingPeriods: [period] }))).toEqual([]);
    expect(
      localStarts(
        generateSlots(
          query({ workingPeriods: [period], dateFrom: "2026-08-03", dateTo: "2026-08-03" }),
        ),
      ),
    ).toEqual(["09:00", "10:00", "11:00"]);
  });

  // §13.5 — multiple working periods on one day
  it("handles multiple periods on one day", () => {
    const slots = generateSlots(
      query({
        workingPeriods: [
          { weekday: 1, startTime: "09:00", endTime: "12:00" },
          { weekday: 1, startTime: "13:00", endTime: "17:00" },
        ],
      }),
    );

    expect(localStarts(slots)).toEqual([
      "09:00",
      "10:00",
      "11:00",
      "13:00",
      "14:00",
      "15:00",
      "16:00",
    ]);
  });

  // §13.5 — lunch break
  it("leaves a lunch break empty", () => {
    // The break is the gap between two periods: nothing may start at 12:00 and
    // nothing may run through 12:00–13:00.
    const slots = generateSlots(
      query({
        serviceDurationMinutes: 30,
        slotIntervalMinutes: 30,
        workingPeriods: [
          { weekday: 1, startTime: "11:00", endTime: "12:00" },
          { weekday: 1, startTime: "13:00", endTime: "14:00" },
        ],
      }),
    );

    expect(localStarts(slots)).toEqual(["11:00", "11:30", "13:00", "13:30"]);
  });

  // §13.5 — additional Saturday opening
  it("adds a one-off Saturday opening", () => {
    const saturday = "2026-08-01";

    const slots = generateSlots(
      query({
        dateFrom: saturday,
        dateTo: saturday,
        // No recurring Saturday hours at all.
        workingPeriods: [{ weekday: 1, startTime: "09:00", endTime: "17:00" }],
        additionalPeriods: [local(saturday, "10:00", "12:00")],
      }),
    );

    expect(localStarts(slots)).toEqual(["10:00", "11:00"]);
  });

  // §13.5 — appointment crossing midnight
  it("handles a period that runs past midnight", () => {
    const slots = generateSlots(
      query({
        dateFrom: MONDAY,
        dateTo: "2026-07-28",
        serviceDurationMinutes: 60,
        slotIntervalMinutes: 60,
        // A late shift: Monday 22:00 through Tuesday 02:00.
        workingPeriods: [{ weekday: 1, startTime: "22:00", endTime: "02:00" }],
      }),
    );

    expect(localStarts(slots)).toEqual(["22:00", "23:00", "00:00", "01:00"]);

    // The appointment that starts before midnight ends after it.
    const crossing = slots[1]!;
    expect(crossing.startAt).toBe("2026-07-27T21:00:00.000Z");
    expect(crossing.endAt).toBe("2026-07-27T22:00:00.000Z");
  });

  it("includes a night shift that began the day before the requested range", () => {
    // Monday 22:00–02:00 contributes hours to Tuesday morning. Asking only
    // about Tuesday must still find them.
    const slots = generateSlots(
      query({
        dateFrom: "2026-07-28",
        dateTo: "2026-07-28",
        workingPeriods: [{ weekday: 1, startTime: "22:00", endTime: "02:00" }],
      }),
    );

    expect(localStarts(slots)).toEqual(["00:00", "01:00"]);
  });
});

describe("exceptions", () => {
  // §13.5 — full-day exception
  it("removes a full-day closure", () => {
    const slots = generateSlots(query({ unavailablePeriods: [local(MONDAY, "00:00", "24:00")] }));

    expect(slots).toEqual([]);
  });

  // §13.5 — partial-day exception
  it("removes a partial-day closure", () => {
    const slots = generateSlots(query({ unavailablePeriods: [local(MONDAY, "10:00", "11:00")] }));

    expect(localStarts(slots)).toEqual(["09:00", "11:00"]);
  });

  it("lets an additional period reopen time the recurring schedule does not cover", () => {
    const slots = generateSlots(query({ additionalPeriods: [local(MONDAY, "17:00", "19:00")] }));

    expect(localStarts(slots)).toEqual(["09:00", "10:00", "11:00", "17:00", "18:00"]);
  });

  it("subtracts a closure even from an additional opening", () => {
    // Order matters: §13.3 adds availability before it subtracts. A holiday
    // beats a one-off opening, not the other way round.
    const slots = generateSlots(
      query({
        additionalPeriods: [local(MONDAY, "17:00", "19:00")],
        unavailablePeriods: [local(MONDAY, "00:00", "24:00")],
      }),
    );

    expect(slots).toEqual([]);
  });
});

describe("bookings, holds and external calendars", () => {
  // §13.5 — back-to-back appointments
  it("offers the slot immediately after a booking ends", () => {
    const slots = generateSlots(query({ bookings: [local(MONDAY, "09:00", "10:00")] }));

    expect(localStarts(slots)).toEqual(["10:00", "11:00"]);
  });

  // §13.5 — active hold conflict
  it("treats an active hold exactly like a booking", () => {
    const slots = generateSlots(query({ activeHolds: [local(MONDAY, "10:00", "11:00")] }));

    expect(localStarts(slots)).toEqual(["09:00", "11:00"]);
  });

  // §13.5 — external calendar conflict
  it("subtracts external calendar busy time", () => {
    const slots = generateSlots(query({ externalBusyPeriods: [local(MONDAY, "11:00", "12:00")] }));

    expect(localStarts(slots)).toEqual(["09:00", "10:00"]);
  });

  it("subtracts all three sources at once", () => {
    const slots = generateSlots(
      query({
        workingPeriods: [{ weekday: 1, startTime: "09:00", endTime: "13:00" }],
        bookings: [local(MONDAY, "09:00", "10:00")],
        activeHolds: [local(MONDAY, "11:00", "12:00")],
        externalBusyPeriods: [local(MONDAY, "12:00", "13:00")],
      }),
    );

    expect(localStarts(slots)).toEqual(["10:00"]);
  });

  it("is unaffected by a booking that ends before the day starts", () => {
    const slots = generateSlots(query({ bookings: [local(MONDAY, "07:00", "08:00")] }));

    expect(localStarts(slots)).toEqual(["09:00", "10:00", "11:00"]);
  });
});

describe("duration, buffers and slot interval", () => {
  // §13.5 — slot interval different from service duration
  it("steps on the slot interval, not the service duration", () => {
    const slots = generateSlots(
      query({
        serviceDurationMinutes: 45,
        slotIntervalMinutes: 15,
        workingPeriods: [{ weekday: 1, startTime: "09:00", endTime: "11:00" }],
      }),
    );

    expect(localStarts(slots)).toEqual(["09:00", "09:15", "09:30", "09:45", "10:00", "10:15"]);
  });

  it("does not offer a slot whose appointment would overrun the working period", () => {
    const slots = generateSlots(
      query({
        serviceDurationMinutes: 90,
        slotIntervalMinutes: 60,
        workingPeriods: [{ weekday: 1, startTime: "09:00", endTime: "12:00" }],
      }),
    );

    // 11:00 would end at 12:30, past closing.
    expect(localStarts(slots)).toEqual(["09:00", "10:00"]);
  });

  // §13.5 — service buffers
  it("reports the occupied span including buffers", () => {
    const slots = generateSlots(
      query({
        serviceDurationMinutes: 30,
        bufferBeforeMinutes: 10,
        bufferAfterMinutes: 15,
        slotIntervalMinutes: 30,
        workingPeriods: [{ weekday: 1, startTime: "09:00", endTime: "11:00" }],
      }),
    );

    const first = slots[0]!;
    // The buffers must fit inside working time, so the first appointment is at
    // 09:10 rather than 09:00 — the preparation cannot happen before opening.
    expect(localStarts([first])).toEqual(["09:30"]);
    expect(first.occupiedFrom).toBe("2026-07-27T07:20:00.000Z"); // 09:20 local
    expect(first.startAt).toBe("2026-07-27T07:30:00.000Z"); // 09:30
    expect(first.endAt).toBe("2026-07-27T08:00:00.000Z"); // 10:00
    expect(first.occupiedUntil).toBe("2026-07-27T08:15:00.000Z"); // 10:15
  });

  it("keeps buffers clear of an adjacent booking", () => {
    const slots = generateSlots(
      query({
        serviceDurationMinutes: 30,
        bufferBeforeMinutes: 15,
        bufferAfterMinutes: 0,
        slotIntervalMinutes: 30,
        workingPeriods: [{ weekday: 1, startTime: "09:00", endTime: "11:00" }],
        bookings: [local(MONDAY, "09:00", "10:00")],
      }),
    );

    // 10:00 is free but its 15-minute run-up overlaps the booking, so the first
    // offer is 10:30.
    expect(localStarts(slots)).toEqual(["10:30"]);
  });
});

describe("booking window", () => {
  // §13.5 — minimum notice
  it("applies minimum notice", () => {
    const slots = generateSlots(
      query({
        // 09:20 local on the day itself.
        now: "2026-07-27T07:20:00Z",
        minimumNoticeMinutes: 120,
      }),
    );

    // Earliest permitted start is 11:20 local, so 11:00 is out.
    expect(localStarts(slots)).toEqual([]);
  });

  it("allows a slot exactly at the notice boundary", () => {
    const slots = generateSlots(
      query({
        now: "2026-07-27T07:00:00Z", // 09:00 local
        minimumNoticeMinutes: 120,
      }),
    );

    expect(localStarts(slots)).toEqual(["11:00"]);
  });

  // §13.5 — maximum advance window
  it("applies the maximum advance window", () => {
    const slots = generateSlots(
      query({
        now: "2026-07-20T08:00:00Z", // the Monday a week earlier
        maximumAdvanceDays: 3,
      }),
    );

    expect(slots).toEqual([]);
  });

  it("includes the whole of the last permitted day", () => {
    const slots = generateSlots(
      query({
        now: "2026-07-20T08:00:00Z",
        maximumAdvanceDays: 7,
      }),
    );

    expect(localStarts(slots)).toEqual(["09:00", "10:00", "11:00"]);
  });

  it("returns nothing when notice and advance windows cannot both be satisfied", () => {
    expect(
      generateSlots(query({ minimumNoticeMinutes: 60 * 24 * 30, maximumAdvanceDays: 1 })),
    ).toEqual([]);
  });
});

describe("daylight saving", () => {
  // §13.5 — daylight-saving start
  it("keeps the working day at its wall-clock times when the clocks spring forward", () => {
    // 2026-03-29 is a Sunday: 02:00 → 03:00 local, so the day is 23 hours long.
    const sunday = "2026-03-29";

    const slots = generateSlots(
      query({
        dateFrom: sunday,
        dateTo: sunday,
        workingPeriods: [{ weekday: 7, startTime: "09:00", endTime: "12:00" }],
        now: "2026-03-01T00:00:00Z",
      }),
    );

    // The clinic still opens at 09:00 local and closes at 12:00 local.
    expect(localStarts(slots)).toEqual(["09:00", "10:00", "11:00"]);
    // And 09:00 local is 07:00Z that day, not the 08:00Z it was the day before.
    expect(slots[0]!.startAt).toBe("2026-03-29T07:00:00.000Z");
  });

  it("loses the hour that does not exist on a spring-forward morning", () => {
    const sunday = "2026-03-29";

    const slots = generateSlots(
      query({
        dateFrom: sunday,
        dateTo: sunday,
        // A night shift straddling the gap: 01:00–05:00 local is only three
        // hours of real time that day.
        workingPeriods: [{ weekday: 7, startTime: "01:00", endTime: "05:00" }],
        now: "2026-03-01T00:00:00Z",
      }),
    );

    // 02:00 never happens, so it is not offered.
    expect(localStarts(slots)).toEqual(["01:00", "03:00", "04:00"]);
  });

  // §13.5 — daylight-saving end
  it("keeps the working day at its wall-clock times when the clocks fall back", () => {
    const sunday = "2026-10-25";

    const slots = generateSlots(
      query({
        dateFrom: sunday,
        dateTo: sunday,
        workingPeriods: [{ weekday: 7, startTime: "09:00", endTime: "12:00" }],
        now: "2026-10-01T00:00:00Z",
      }),
    );

    expect(localStarts(slots)).toEqual(["09:00", "10:00", "11:00"]);
    // 09:00 local is 08:00Z now that the offset is back to +1.
    expect(slots[0]!.startAt).toBe("2026-10-25T08:00:00.000Z");
  });

  it("gains the repeated hour on a fall-back morning", () => {
    const sunday = "2026-10-25";

    const slots = generateSlots(
      query({
        dateFrom: sunday,
        dateTo: sunday,
        // 01:00–05:00 local is five hours of real time that day, because 02:00
        // happens twice.
        workingPeriods: [{ weekday: 7, startTime: "01:00", endTime: "05:00" }],
        now: "2026-10-01T00:00:00Z",
      }),
    );

    // Five slots, and two of them read 02:00 — an hour apart in real time.
    expect(localStarts(slots)).toEqual(["01:00", "02:00", "02:00", "03:00", "04:00"]);
    expect(slots).toHaveLength(5);
    expect(Date.parse(slots[2]!.startAt) - Date.parse(slots[1]!.startAt)).toBe(3_600_000);
  });

  it("spans a transition inside a multi-day range without drifting", () => {
    const slots = generateSlots(
      query({
        dateFrom: "2026-03-27",
        dateTo: "2026-03-30",
        workingPeriods: [
          { weekday: 5, startTime: "09:00", endTime: "10:00" },
          { weekday: 6, startTime: "09:00", endTime: "10:00" },
          { weekday: 7, startTime: "09:00", endTime: "10:00" },
          { weekday: 1, startTime: "09:00", endTime: "10:00" },
        ],
        now: "2026-03-01T00:00:00Z",
      }),
    );

    // Four consecutive days, every one opening at 09:00 local.
    expect(localStarts(slots)).toEqual(["09:00", "09:00", "09:00", "09:00"]);
    expect(slots.map((slot) => slot.startAt)).toEqual([
      "2026-03-27T08:00:00.000Z",
      "2026-03-28T08:00:00.000Z",
      "2026-03-29T07:00:00.000Z",
      "2026-03-30T07:00:00.000Z",
    ]);
  });
});

describe("determinism and ordering", () => {
  it("returns slots in chronological order across several days", () => {
    const slots = generateSlots(
      query({
        dateFrom: MONDAY,
        dateTo: "2026-07-29",
        workingPeriods: [
          { weekday: 3, startTime: "09:00", endTime: "10:00" },
          { weekday: 1, startTime: "09:00", endTime: "10:00" },
          { weekday: 2, startTime: "09:00", endTime: "10:00" },
        ],
      }),
    );

    const starts = slots.map((slot) => Date.parse(slot.startAt));
    expect(starts).toEqual([...starts].sort((left, right) => left - right));
    expect(starts).toHaveLength(3);
  });

  it("offers an instant once even when two availability windows overlap", () => {
    const slots = generateSlots(
      query({
        workingPeriods: [
          { weekday: 1, startTime: "09:00", endTime: "12:00" },
          { weekday: 1, startTime: "09:00", endTime: "11:00" },
        ],
      }),
    );

    expect(localStarts(slots)).toEqual(["09:00", "10:00", "11:00"]);
  });

  it("gives the same answer twice", () => {
    const input = query({
      workingPeriods: [
        { weekday: 1, startTime: "09:00", endTime: "12:00" },
        { weekday: 1, startTime: "13:00", endTime: "17:00" },
      ],
      bookings: [local(MONDAY, "10:00", "11:00")],
      serviceDurationMinutes: 45,
      slotIntervalMinutes: 15,
      bufferBeforeMinutes: 5,
      bufferAfterMinutes: 5,
    });

    expect(generateSlots(input)).toEqual(generateSlots(input));
  });
});

describe("rejected queries", () => {
  it("refuses a query that cannot mean anything", () => {
    expect(() => generateSlots(query({ serviceDurationMinutes: 0 }))).toThrow(/duration/i);
    expect(() => generateSlots(query({ slotIntervalMinutes: 0 }))).toThrow(/interval/i);
    expect(() => generateSlots(query({ bufferBeforeMinutes: -5 }))).toThrow(/buffer/i);
    expect(() => generateSlots(query({ minimumNoticeMinutes: -1 }))).toThrow(/notice/i);
    expect(() => generateSlots(query({ maximumAdvanceDays: -1 }))).toThrow(/advance/i);
    expect(() => generateSlots(query({ now: "not a date" }))).toThrow(/instant/i);
    expect(() => generateSlots(query({ dateFrom: "27-07-2026" }))).toThrow(/YYYY-MM-DD/);
  });
});
