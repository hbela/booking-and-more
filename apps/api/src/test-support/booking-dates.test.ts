import { describe, expect, it } from "vitest";
import { budapestHour, futureMonday } from "./booking-dates.js";

describe("booking date fixtures", () => {
  it.each([
    ["2026-09-15T23:59:59Z", "2026-09-28"],
    ["2026-09-21T00:00:00Z", "2026-09-28"],
    ["2026-12-31T12:00:00Z", "2027-01-11"],
    ["2028-02-27T12:00:00Z", "2028-03-06"],
  ])("keeps Monday safely ahead of %s", (now, expected) => {
    expect(futureMonday(new Date(now))).toBe(expected);
  });

  it.each([
    ["2026-01-12", "2026-01-12T09:00:00.000Z"],
    ["2026-07-13", "2026-07-13T08:00:00.000Z"],
    ["2026-03-30", "2026-03-30T08:00:00.000Z"],
    ["2026-10-26", "2026-10-26T09:00:00.000Z"],
  ])("keeps a 10:00 Budapest appointment at the right instant on %s", (date, expected) => {
    expect(budapestHour(date, 10)).toBe(expected);
  });
});
