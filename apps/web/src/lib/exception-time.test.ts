import { describe, expect, it } from "vitest";
import { formatInZone, resolveInZone, toLocalInputValue } from "./exception-time";

/**
 * The provider's zone decides the instant — never the browser's.
 *
 * `Australia/Lord_Howe` earns its place here: its DST shift is 30 minutes, not
 * an hour, and assuming otherwise is the exact defect the availability engine
 * was amended for (phase-3 §2.2.1). A conversion that only ever sees
 * Europe/Budapest looks correct while being wrong for a whole class of zone.
 */

describe("resolving a datetime-local value", () => {
  it("uses the provider's zone, not the machine's", () => {
    // 09:00 in Budapest in August is 07:00Z, whatever the admin's own clock says.
    expect(resolveInZone("2026-08-10T09:00", "Europe/Budapest")).toEqual({
      instant: "2026-08-10T07:00:00.000Z",
      resolution: "exact",
    });

    // The same reading, a different diary.
    expect(resolveInZone("2026-08-10T09:00", "UTC")?.instant).toBe("2026-08-10T09:00:00.000Z");
  });

  it("reports a reading the clocks jumped over, and snaps forward", () => {
    // Budapest springs forward 2026-03-29: 02:00 → 03:00, so 02:30 never happens.
    const resolved = resolveInZone("2026-03-29T02:30", "Europe/Budapest");

    expect(resolved?.resolution).toBe("skipped");
    // Snapped to the first reading that exists, which is 03:00 local = 01:00Z.
    expect(resolved?.instant).toBe("2026-03-29T01:00:00.000Z");
  });

  it("reports a reading that happens twice, and takes the earlier", () => {
    // Budapest falls back 2026-10-25: 03:00 → 02:00, so 02:30 comes round twice.
    const resolved = resolveInZone("2026-10-25T02:30", "Europe/Budapest");

    expect(resolved?.resolution).toBe("ambiguous");
    // The earlier of the two, still on summer time (UTC+2).
    expect(resolved?.instant).toBe("2026-10-25T00:30:00.000Z");
  });

  it("handles a half-hour DST shift, not just a whole-hour one", () => {
    // Lord Howe moves by 30 minutes. A conversion that assumed an hour would
    // land in the wrong place here while calling itself exact.
    const skipped = resolveInZone("2026-10-04T02:15", "Australia/Lord_Howe");

    expect(skipped?.resolution).toBe("skipped");
    // 02:00 → 02:30, so 02:15 snaps to 02:30 local (UTC+11) = 15:30Z the day before.
    expect(skipped?.instant).toBe("2026-10-03T15:30:00.000Z");
  });

  it("returns null for a value the input has not finished producing", () => {
    expect(resolveInZone("", "Europe/Budapest")).toBeNull();
    expect(resolveInZone("2026-08-10", "Europe/Budapest")).toBeNull();
  });

  it("accepts the seconds some browsers append", () => {
    expect(resolveInZone("2026-08-10T09:00:00", "Europe/Budapest")?.instant).toBe(
      "2026-08-10T07:00:00.000Z",
    );
  });
});

describe("loading an instant back into the form", () => {
  it("round-trips through the provider's zone", () => {
    const value = "2026-08-10T09:00";
    const resolved = resolveInZone(value, "Europe/Budapest")!;

    expect(toLocalInputValue(resolved.instant, "Europe/Budapest")).toBe(value);
  });

  it("shows the provider's reading, not the reader's", () => {
    // The list rendered with toLocaleString() before, which was the admin's zone
    // — so a fix to the input alone would still have shown the wrong time back.
    expect(toLocalInputValue("2026-08-10T07:00:00.000Z", "Europe/Budapest")).toBe(
      "2026-08-10T09:00",
    );
    expect(toLocalInputValue("2026-08-10T07:00:00.000Z", "America/New_York")).toBe(
      "2026-08-10T03:00",
    );
  });
});

describe("formatting for display", () => {
  it("formats in the provider's zone", () => {
    const budapest = formatInZone("2026-08-10T07:00:00.000Z", "Europe/Budapest", "en");
    const newYork = formatInZone("2026-08-10T07:00:00.000Z", "America/New_York", "en");

    expect(budapest).not.toBe(newYork);
    expect(budapest).toContain("9:00");
    expect(newYork).toContain("3:00");
  });
});
