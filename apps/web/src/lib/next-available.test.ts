import { describe, expect, it } from "vitest";
import { localDayOf } from "./month-availability";
import { firstAcrossMonths, nextAvailableDays } from "./next-available";

/**
 * The "nothing this month" escape hatch.
 *
 * The date arithmetic these used to test moved to `./month-availability` with
 * `localDayOf` and the day grouping; what is left is the ordering, which is the
 * part that decides where a customer is sent.
 */

function slot(startAt: string, providerId = "p1"): { startAt: string; providerId: string } {
  return { startAt, providerId };
}

describe("nextAvailableDays", () => {
  it("returns nothing for no slots", () => {
    expect(nextAvailableDays([])).toEqual([]);
  });

  it("returns the earliest day by default, with its distinct-start count", () => {
    const days = nextAvailableDays([
      slot("2026-09-20T09:00:00.000Z"),
      slot("2026-09-14T07:00:00.000Z", "p1"),
      slot("2026-09-14T07:00:00.000Z", "p2"),
      slot("2026-09-14T07:15:00.000Z"),
    ]);

    expect(days).toHaveLength(1);
    expect(days[0]).toMatchObject({
      date: localDayOf("2026-09-14T07:00:00.000Z"),
      count: 2,
      firstStartAt: "2026-09-14T07:00:00.000Z",
    });
  });

  it("orders days earliest first whatever the input order", () => {
    const days = nextAvailableDays(
      [
        slot("2026-09-20T10:00:00.000Z"),
        slot("2026-09-14T11:00:00.000Z"),
        slot("2026-09-14T08:00:00.000Z"),
      ],
      3,
    );

    expect(days.map((entry) => entry.firstStartAt)).toEqual([
      "2026-09-14T08:00:00.000Z",
      "2026-09-20T10:00:00.000Z",
    ]);
  });
});

describe("firstAcrossMonths", () => {
  it("returns null when every month is empty", () => {
    expect(firstAcrossMonths([[], []])).toBeNull();
  });

  it("takes the earliest day across months", () => {
    const found = firstAcrossMonths([
      [slot("2026-10-05T08:00:00.000Z")],
      [slot("2026-09-28T08:00:00.000Z")],
    ]);

    expect(found?.firstStartAt).toBe("2026-09-28T08:00:00.000Z");
  });

  it("does not care which month's query resolved first", () => {
    // The months arrive as independent query results, so the caller cannot
    // guarantee their order — the sort has to do it.
    const early = [slot("2026-09-28T08:00:00.000Z")];
    const late = [slot("2026-10-05T08:00:00.000Z")];

    expect(firstAcrossMonths([early, late])?.date).toBe(firstAcrossMonths([late, early])?.date);
  });

  it("skips an empty month to reach a later one", () => {
    const found = firstAcrossMonths([[], [slot("2026-11-02T08:00:00.000Z")]]);
    expect(found?.firstStartAt).toBe("2026-11-02T08:00:00.000Z");
  });
});
