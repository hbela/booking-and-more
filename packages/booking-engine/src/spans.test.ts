import { describe, expect, it } from "vitest";
import {
  durationMinutesOf,
  isPositiveSpan,
  occupiedSpanFor,
  parseInstant,
  spansOverlap,
  toInstant,
} from "./spans.js";

describe("occupiedSpanFor", () => {
  it("separates what the customer is told from what the diary loses", () => {
    const span = occupiedSpanFor({
      startAt: "2026-08-05T10:00:00.000Z",
      durationMinutes: 45,
      bufferBeforeMinutes: 10,
      bufferAfterMinutes: 10,
    });

    // The customer's appointment is exactly what they picked.
    expect(span.appointment).toEqual({
      startAt: "2026-08-05T10:00:00.000Z",
      endAt: "2026-08-05T10:45:00.000Z",
    });

    // The diary loses the buffers too.
    expect(span.occupied).toEqual({
      startAt: "2026-08-05T09:50:00.000Z",
      endAt: "2026-08-05T10:55:00.000Z",
    });
  });

  it("leaves the appointment alone when there are no buffers", () => {
    const span = occupiedSpanFor({
      startAt: "2026-08-05T10:00:00.000Z",
      durationMinutes: 30,
      bufferBeforeMinutes: 0,
      bufferAfterMinutes: 0,
    });

    expect(span.occupied).toEqual(span.appointment);
  });

  it("applies asymmetric buffers to the correct end", () => {
    const span = occupiedSpanFor({
      startAt: "2026-08-05T10:00:00.000Z",
      durationMinutes: 30,
      bufferBeforeMinutes: 0,
      bufferAfterMinutes: 20,
    });

    expect(span.occupied.startAt).toBe("2026-08-05T10:00:00.000Z");
    expect(span.occupied.endAt).toBe("2026-08-05T10:50:00.000Z");
  });

  it("normalises the offset to UTC so two spellings of one instant compare equal", () => {
    // The API stores timestamptz and hands back Z-suffixed strings; a caller may
    // send "+02:00". They are the same moment and must produce the same row.
    const budapest = occupiedSpanFor({
      startAt: "2026-08-05T12:00:00+02:00",
      durationMinutes: 30,
      bufferBeforeMinutes: 0,
      bufferAfterMinutes: 0,
    });

    expect(budapest.appointment.startAt).toBe("2026-08-05T10:00:00.000Z");
  });

  it("refuses a duration that is not a positive whole number of minutes", () => {
    const base = {
      startAt: "2026-08-05T10:00:00.000Z",
      bufferBeforeMinutes: 0,
      bufferAfterMinutes: 0,
    };

    expect(() => occupiedSpanFor({ ...base, durationMinutes: 0 })).toThrow(RangeError);
    expect(() => occupiedSpanFor({ ...base, durationMinutes: -30 })).toThrow(RangeError);
    expect(() => occupiedSpanFor({ ...base, durationMinutes: 30.5 })).toThrow(RangeError);
  });

  it("refuses a negative buffer", () => {
    const base = {
      startAt: "2026-08-05T10:00:00.000Z",
      durationMinutes: 30,
      bufferBeforeMinutes: 0,
      bufferAfterMinutes: 0,
    };

    expect(() => occupiedSpanFor({ ...base, bufferBeforeMinutes: -5 })).toThrow(RangeError);
    expect(() => occupiedSpanFor({ ...base, bufferAfterMinutes: -5 })).toThrow(RangeError);
  });
});

describe("parseInstant", () => {
  it("refuses a malformed instant rather than yielding NaN", () => {
    // The failure this prevents: NaN flows onward, becomes an Invalid Date, and
    // Postgres rejects the INSERT somewhere that says nothing about the caller.
    expect(() => parseInstant("not a date")).toThrow(RangeError);
    expect(() => parseInstant("")).toThrow(RangeError);
  });

  it("round-trips through toInstant", () => {
    const iso = "2026-08-05T10:00:00.000Z";
    expect(toInstant(parseInstant(iso))).toBe(iso);
  });
});

describe("spansOverlap", () => {
  const span = (startAt: string, endAt: string) => ({ startAt, endAt });

  it("treats back-to-back appointments as not overlapping", () => {
    // The half-open convention, and the reason it matters: 10:00-10:30 followed
    // by 10:30-11:00 is a normal morning, not a double booking. This must agree
    // with tstzrange(start_at, end_at, '[)') in the exclusion constraint.
    expect(
      spansOverlap(
        span("2026-08-05T10:00:00Z", "2026-08-05T10:30:00Z"),
        span("2026-08-05T10:30:00Z", "2026-08-05T11:00:00Z"),
      ),
    ).toBe(false);
  });

  it("catches a one-minute encroachment", () => {
    expect(
      spansOverlap(
        span("2026-08-05T10:00:00Z", "2026-08-05T10:30:00Z"),
        span("2026-08-05T10:29:00Z", "2026-08-05T11:00:00Z"),
      ),
    ).toBe(true);
  });

  it("catches full containment in both directions", () => {
    const outer = span("2026-08-05T09:00:00Z", "2026-08-05T12:00:00Z");
    const inner = span("2026-08-05T10:00:00Z", "2026-08-05T10:30:00Z");

    expect(spansOverlap(outer, inner)).toBe(true);
    expect(spansOverlap(inner, outer)).toBe(true);
  });

  it("reports no overlap for spans on different days", () => {
    expect(
      spansOverlap(
        span("2026-08-05T10:00:00Z", "2026-08-05T10:30:00Z"),
        span("2026-08-06T10:00:00Z", "2026-08-06T10:30:00Z"),
      ),
    ).toBe(false);
  });
});

describe("durationMinutesOf and isPositiveSpan", () => {
  it("measures a span in minutes", () => {
    expect(
      durationMinutesOf({ startAt: "2026-08-05T10:00:00Z", endAt: "2026-08-05T10:45:00Z" }),
    ).toBe(45);
  });

  it("rejects a zero-length or backwards span", () => {
    expect(isPositiveSpan({ startAt: "2026-08-05T10:00:00Z", endAt: "2026-08-05T10:00:00Z" })).toBe(
      false,
    );
    expect(isPositiveSpan({ startAt: "2026-08-05T11:00:00Z", endAt: "2026-08-05T10:00:00Z" })).toBe(
      false,
    );
    expect(isPositiveSpan({ startAt: "2026-08-05T10:00:00Z", endAt: "2026-08-05T10:01:00Z" })).toBe(
      true,
    );
  });
});
