import { describe, expect, it } from "vitest";
import { ACCESS_TOKEN_SKEW_MS, isAccessTokenStale } from "./google.tokens.js";

const NOW = new Date("2026-09-07T08:00:00.000Z");

function inMinutes(minutes: number): Date {
  return new Date(NOW.getTime() + minutes * 60_000);
}

describe("isAccessTokenStale", () => {
  it("keeps a token with plenty of life left", () => {
    expect(isAccessTokenStale(inMinutes(45), NOW)).toBe(false);
  });

  it("replaces one that has already expired", () => {
    expect(isAccessTokenStale(inMinutes(-1), NOW)).toBe(true);
  });

  it("replaces one inside the safety margin", () => {
    // The case the margin exists for: still valid by the clock, but not for
    // long enough to survive a batch of calendar writes.
    expect(isAccessTokenStale(inMinutes(4), NOW)).toBe(true);
    expect(isAccessTokenStale(inMinutes(6), NOW)).toBe(false);
  });

  it("treats the boundary as stale rather than fresh", () => {
    expect(isAccessTokenStale(new Date(NOW.getTime() + ACCESS_TOKEN_SKEW_MS), NOW)).toBe(true);
  });

  it("treats an unknown expiry as expired", () => {
    // "I do not know when this expires" has one safe reading. Refreshing costs a
    // request; guessing wrong costs a failed write and a misleading 401.
    expect(isAccessTokenStale(null, NOW)).toBe(true);
    expect(isAccessTokenStale(undefined, NOW)).toBe(true);
  });
});
