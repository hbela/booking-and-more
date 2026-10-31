import { describe, expect, it } from "vitest";
import { createEventBudget, scrubOrDrop } from "./sentry-guard.js";

const error = (value: string) => ({ exception: { values: [{ type: "Error", value }] } });

describe("scrubOrDrop", () => {
  it("returns the scrubbed value", () => {
    expect(scrubOrDrop({ message: "Failed for a@example.com" })).toEqual({
      message: "Failed for [REDACTED_EMAIL]",
    });
  });

  it("drops rather than throws or sends unscrubbed when scrubbing fails", () => {
    const hostile = {
      get email(): string {
        throw new Error("getter exploded");
      },
    };
    expect(scrubOrDrop(hostile)).toBeNull();
  });
});

describe("createEventBudget", () => {
  function clock() {
    let time = 0;
    return { now: () => time, advance: (ms: number) => (time += ms) };
  }

  it("lets the same error through only so often per minute", () => {
    const { now, advance } = clock();
    const allow = createEventBudget({ perKeyPerMinute: 3, perHour: 100, perDay: 100, now });

    const decisions = Array.from({ length: 5 }, () => allow(error("boom")));
    expect(decisions).toEqual([true, true, true, false, false]);
    expect(allow(error("a different failure"))).toBe(true);

    advance(60_000);
    expect(allow(error("boom"))).toBe(true);
  });

  it("caps all errors per hour, whatever their message", () => {
    const { now, advance } = clock();
    const allow = createEventBudget({ perKeyPerMinute: 3, perHour: 5, perDay: 100, now });

    const decisions = Array.from({ length: 7 }, (_, i) => allow(error(`failure ${i}`)));
    expect(decisions.filter(Boolean)).toHaveLength(5);

    advance(59 * 60_000);
    expect(allow(error("still capped"))).toBe(false);
    advance(60_000);
    expect(allow(error("new hour"))).toBe(true);
  });

  it("caps all errors per day, across hours", () => {
    const { now, advance } = clock();
    const allow = createEventBudget({ perKeyPerMinute: 3, perHour: 5, perDay: 8, now });

    let sent = 0;
    for (let hour = 0; hour < 23; hour += 1) {
      for (let i = 0; i < 5; i += 1) if (allow(error(`h${hour} failure ${i}`))) sent += 1;
      advance(60 * 60_000);
    }
    expect(sent).toBe(8);

    advance(60 * 60_000);
    expect(allow(error("new day"))).toBe(true);
  });

  it("would have held the scrubber loop to the daily cap", () => {
    const { now, advance } = clock();
    const allow = createEventBudget({ now });
    let sent = 0;
    // One identical event every ten seconds for a day, as in the incident.
    for (let i = 0; i < 8_640; i += 1) {
      if (allow(error("Maximum call stack size exceeded"))) sent += 1;
      advance(10_000);
    }
    // 6 a minute arrive, 3 pass; the hourly cap of 10 binds, then the daily 20.
    expect(sent).toBe(20);
  });

  it("keys message-only events by their message", () => {
    const allow = createEventBudget({ perKeyPerMinute: 1, now: () => 0 });
    expect(allow({ message: "one" })).toBe(true);
    expect(allow({ message: "one" })).toBe(false);
    expect(allow({ message: "two" })).toBe(true);
  });
});
