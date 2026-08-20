import { describe, expect, it } from "vitest";

import {
  PLAN_QUOTAS,
  USAGE_UNITS,
  isWithinQuota,
  quotaFor,
  usageCategorySchema,
  usagePeriodOf,
} from "./usage.js";

describe("quotaFor", () => {
  it("reads the plan's allowance", () => {
    expect(quotaFor("STARTER", "VOICE_TRANSCRIPTION")).toBe(3_000);
    expect(quotaFor("PROFESSIONAL", "VOICE_TRANSCRIPTION")).toBe(30_000);
  });

  it("keeps Form tenants out of AI and caps AI Receptionist tenants", () => {
    expect(quotaFor("STARTER", "AI_INPUT_TOKENS")).toBe(0);
    expect(quotaFor("STARTER", "AI_OUTPUT_TOKENS")).toBe(0);
    expect(quotaFor("PROFESSIONAL", "AI_INPUT_TOKENS")).toBe(2_000_000);
    expect(quotaFor("PROFESSIONAL", "AI_OUTPUT_TOKENS")).toBe(400_000);
  });

  it("leaves the unsold internal plan unmetered", () => {
    expect(quotaFor("INTERNAL", "VOICE_TRANSCRIPTION")).toBeNull();
  });

  it("does not cap what the product needs to work", () => {
    // Refusing a booking confirmation to save a fraction of a cent would break
    // the product rather than protect it.
    expect(quotaFor("STARTER", "EMAIL_SENT")).toBeNull();
    expect(quotaFor("STARTER", "BOOKING_CREATED")).toBeNull();
  });

  it("refuses realtime on every plan — PRD §23 excludes it from the MVP", () => {
    expect(quotaFor("STARTER", "REALTIME_AUDIO_SECONDS")).toBe(0);
    expect(quotaFor("PROFESSIONAL", "REALTIME_AUDIO_SECONDS")).toBe(0);
  });

  it("falls back to STARTER rather than to unlimited", () => {
    // Guessing low costs a complaint. Guessing high costs an unbounded bill
    // nobody notices.
    expect(quotaFor("ENTERPRISE_TYPO", "VOICE_TRANSCRIPTION")).toBe(3_000);
    expect(quotaFor(null, "VOICE_TRANSCRIPTION")).toBe(3_000);
    expect(quotaFor(undefined, "VOICE_TRANSCRIPTION")).toBe(3_000);
  });
});

describe("isWithinQuota", () => {
  const base = { plan: "STARTER", category: "VOICE_TRANSCRIPTION" } as const;

  it("allows a request that exactly fills the allowance", () => {
    // Otherwise the last unit of every allowance is unusable.
    expect(isWithinQuota({ ...base, consumed: 2_970, requested: 30 })).toBe(true);
  });

  it("refuses the request that would exceed it", () => {
    expect(isWithinQuota({ ...base, consumed: 2_971, requested: 30 })).toBe(false);
  });

  it("refuses everything in a zeroed category", () => {
    expect(
      isWithinQuota({
        plan: "STARTER",
        category: "REALTIME_AUDIO_SECONDS",
        consumed: 0,
        requested: 1,
      }),
    ).toBe(false);
  });

  it("allows anything in an unmetered one", () => {
    expect(
      isWithinQuota({
        plan: "INTERNAL",
        category: "VOICE_TRANSCRIPTION",
        consumed: 10_000_000,
        requested: 30,
      }),
    ).toBe(true);
  });
});

describe("usagePeriodOf", () => {
  it("is the calendar month in UTC", () => {
    expect(usagePeriodOf(new Date("2026-08-10T12:00:00Z"))).toBe("2026-08");
    expect(usagePeriodOf(new Date("2026-01-01T00:00:00Z"))).toBe("2026-01");
  });

  it("rolls over at the same instant everywhere", () => {
    // 23:30 in Budapest on the 31st is already the next month in UTC. Both
    // tenants must land in the same bucket, or a zone change buys an allowance.
    expect(usagePeriodOf(new Date("2026-08-31T23:30:00Z"))).toBe("2026-08");
    expect(usagePeriodOf(new Date("2026-09-01T00:30:00Z"))).toBe("2026-09");
  });
});

describe("the table itself", () => {
  it("covers every category on every plan", () => {
    const categories = usageCategorySchema.options;

    for (const [plan, table] of Object.entries(PLAN_QUOTAS)) {
      for (const category of categories) {
        expect(Object.hasOwn(table, category), `${plan} is missing ${category}`).toBe(true);
      }
    }
  });

  it("names a unit for every category", () => {
    for (const category of usageCategorySchema.options) {
      expect(USAGE_UNITS[category]).toBeTruthy();
    }
  });
});
