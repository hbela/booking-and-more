import { describe, expect, it } from "vitest";
import type { WorkingHoursRow } from "./api-client";
import { END_OF_DAY, buildWorkingHoursBody, seedWorkingWeek } from "./working-hours";

function row(over: Partial<WorkingHoursRow> = {}): WorkingHoursRow {
  return {
    id: "wh1",
    providerId: "prov1",
    locationId: null,
    weekday: 1,
    startTime: "09:00",
    endTime: "17:00",
    validFrom: null,
    validUntil: null,
    active: true,
    ...over,
  };
}

describe("the weekly schedule", () => {
  it("round-trips every field the API returned", () => {
    // The reported bug: the editor sent weekday/start/end only, so a
    // location-scoped period with a validity window came back stripped of both
    // on the next save.
    const week = seedWorkingWeek([
      row({
        locationId: "annexe",
        validFrom: "2026-09-01",
        validUntil: "2026-12-31",
        active: false,
      }),
    ]);

    expect(buildWorkingHoursBody(week).workingHours).toEqual([
      {
        weekday: 1,
        startTime: "09:00",
        endTime: "17:00",
        locationId: "annexe",
        validFrom: "2026-09-01",
        validUntil: "2026-12-31",
        active: false,
      },
    ]);
  });

  it("keeps a period that runs to midnight", () => {
    // `<input type="time">` cannot hold "24:00"; the editor uses a checkbox. If
    // the value did not survive the round trip, a late shift would save as "".
    const week = seedWorkingWeek([row({ startTime: "22:00", endTime: END_OF_DAY })]);

    expect(buildWorkingHoursBody(week).workingHours[0]).toMatchObject({ endTime: "24:00" });
  });

  it("keeps a lunch break as two periods on one day, in order", () => {
    const week = seedWorkingWeek([
      row({ weekday: 2, startTime: "09:00", endTime: "12:00" }),
      row({ weekday: 2, startTime: "13:00", endTime: "17:00" }),
    ]);

    expect(week[2]).toHaveLength(2);
    expect(buildWorkingHoursBody(week).workingHours.map((entry) => entry.startTime)).toEqual([
      "09:00",
      "13:00",
    ]);
  });

  it("orders the flattened week Monday first", () => {
    const week = seedWorkingWeek([
      row({ weekday: 7 }),
      row({ weekday: 1 }),
      row({ weekday: 3 }),
    ]);

    expect(buildWorkingHoursBody(week).workingHours.map((entry) => entry.weekday)).toEqual([
      1, 3, 7,
    ]);
  });

  it("sends an empty week rather than omitting it, so a day can be cleared", () => {
    expect(buildWorkingHoursBody({})).toEqual({ workingHours: [] });
  });

  it("leaves the times untouched — they are wall-clock, not instants", () => {
    // Rule 13. If anybody ever "fixes" these by applying an offset, this fails:
    // 09:00 has to stay 09:00 on the Monday the clocks change.
    const week = seedWorkingWeek([row({ startTime: "09:00", endTime: "17:00" })]);
    const [built] = buildWorkingHoursBody(week).workingHours;

    expect(built).toMatchObject({ startTime: "09:00", endTime: "17:00" });
  });
});
