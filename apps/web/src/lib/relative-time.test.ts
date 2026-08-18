import { describe, expect, it } from "vitest";
import { formatRelativeAge, relativeAge } from "./relative-time";

const now = new Date("2026-08-18T12:00:00.000Z");

function ago(seconds: number): Date {
  return new Date(now.getTime() - seconds * 1000);
}

describe("relativeAge", () => {
  it("calls anything under a minute 'now'", () => {
    expect(relativeAge(ago(0), now)).toEqual({ value: 0, unit: "second" });
    expect(relativeAge(ago(59), now)).toEqual({ value: 0, unit: "second" });
  });

  it("floors rather than rounds, so a bucket is never claimed early", () => {
    // 90 seconds is one minute ago, not two. Rounding would age a change that
    // happened during your edit into one that looks older than your session.
    expect(relativeAge(ago(90), now)).toEqual({ value: -1, unit: "minute" });
    expect(relativeAge(ago(3599), now)).toEqual({ value: -59, unit: "minute" });
  });

  it("steps up through hours, days, months and years", () => {
    expect(relativeAge(ago(3600), now)).toEqual({ value: -1, unit: "hour" });
    expect(relativeAge(ago(86_400), now)).toEqual({ value: -1, unit: "day" });
    expect(relativeAge(ago(2_592_000), now)).toEqual({ value: -1, unit: "month" });
    expect(relativeAge(ago(31_536_000), now)).toEqual({ value: -1, unit: "year" });
  });

  it("clamps a future instant to 'now' rather than rendering it as the future", () => {
    // A clock a few seconds fast would otherwise print "in 4 seconds" against a
    // save that has already happened, which reads as a bug in the screen.
    expect(relativeAge(new Date(now.getTime() + 4000), now)).toEqual({
      value: 0,
      unit: "second",
    });
  });

  it("takes an ISO string, which is what the API sends", () => {
    expect(relativeAge("2026-08-18T11:30:00.000Z", now)).toEqual({ value: -30, unit: "minute" });
  });
});

describe("formatRelativeAge", () => {
  it("formats in the caller's locale, with no message key of ours", () => {
    expect(formatRelativeAge(ago(600), now, "en")).toBe("10 minutes ago");
    // The point of returning (value, unit): Hungarian plurals come from Intl.
    expect(formatRelativeAge(ago(600), now, "hu")).toBe("10 perccel ezelőtt");
  });

  it("says 'now' rather than 'in 0 seconds'", () => {
    expect(formatRelativeAge(ago(3), now, "en")).toBe("now");
  });
});
