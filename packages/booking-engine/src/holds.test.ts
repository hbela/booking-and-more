import { describe, expect, it } from "vitest";
import {
  checkHoldReleasable,
  checkHoldUsable,
  effectiveHoldStatus,
  holdExpiresAt,
  holdRemainingSeconds,
} from "./holds.js";
import { HoldStatuses } from "./types.js";

const NOW = "2026-08-05T10:00:00.000Z";

describe("holdExpiresAt", () => {
  it("adds the hold duration to now", () => {
    expect(holdExpiresAt(NOW, 5)).toBe("2026-08-05T10:05:00.000Z");
  });

  it("refuses a nonsensical duration", () => {
    expect(() => holdExpiresAt(NOW, 0)).toThrow(RangeError);
    expect(() => holdExpiresAt(NOW, -5)).toThrow(RangeError);
  });
});

describe("effectiveHoldStatus", () => {
  it("reports an ACTIVE hold past its deadline as EXPIRED without anything having written that", () => {
    // The point of the whole design: there is no scheduler until Epic 5, so
    // `expires_at` is the truth and `status` is a cache of it.
    const hold = { status: HoldStatuses.ACTIVE, expiresAt: "2026-08-05T10:05:00.000Z" };

    expect(effectiveHoldStatus(hold, "2026-08-05T10:04:59.999Z")).toBe(HoldStatuses.ACTIVE);
    expect(effectiveHoldStatus(hold, "2026-08-05T10:05:00.000Z")).toBe(HoldStatuses.EXPIRED);
    expect(effectiveHoldStatus(hold, "2026-08-05T10:06:00.000Z")).toBe(HoldStatuses.EXPIRED);
  });

  it("leaves a terminal status alone however much time passes", () => {
    // A confirmed hold does not become expired just because its original
    // deadline went by — it already did its job.
    const confirmed = { status: HoldStatuses.CONFIRMED, expiresAt: "2026-08-05T10:05:00.000Z" };

    expect(effectiveHoldStatus(confirmed, "2027-01-01T00:00:00.000Z")).toBe(HoldStatuses.CONFIRMED);

    const released = { status: HoldStatuses.RELEASED, expiresAt: "2026-08-05T10:05:00.000Z" };
    expect(effectiveHoldStatus(released, "2027-01-01T00:00:00.000Z")).toBe(HoldStatuses.RELEASED);
  });

  it("expires exactly at the deadline, not a millisecond later", () => {
    // Half-open again: the hold covers [created, expires), so the deadline
    // instant itself is already too late.
    const hold = { status: HoldStatuses.ACTIVE, expiresAt: NOW };
    expect(effectiveHoldStatus(hold, NOW)).toBe(HoldStatuses.EXPIRED);
  });
});

describe("checkHoldUsable", () => {
  it("allows a live hold", () => {
    const decision = checkHoldUsable(
      { status: HoldStatuses.ACTIVE, expiresAt: "2026-08-05T10:05:00.000Z" },
      NOW,
    );

    expect(decision.allowed).toBe(true);
  });

  it("distinguishes the three ways a hold can be unusable", () => {
    // Three different things to say to a customer, so three different reasons:
    // "it ran out" invites another try, "already booked" must not.
    const expired = checkHoldUsable(
      { status: HoldStatuses.ACTIVE, expiresAt: "2026-08-05T09:00:00.000Z" },
      NOW,
    );
    expect(expired).toMatchObject({ allowed: false, reason: "HOLD_EXPIRED" });

    const released = checkHoldUsable(
      { status: HoldStatuses.RELEASED, expiresAt: "2026-08-05T10:05:00.000Z" },
      NOW,
    );
    expect(released).toMatchObject({ allowed: false, reason: "HOLD_RELEASED" });

    const confirmed = checkHoldUsable(
      { status: HoldStatuses.CONFIRMED, expiresAt: "2026-08-05T10:05:00.000Z" },
      NOW,
    );
    expect(confirmed).toMatchObject({ allowed: false, reason: "HOLD_ALREADY_CONFIRMED" });
  });

  it("carries the deadline back so the caller can say when it lapsed", () => {
    const decision = checkHoldUsable(
      { status: HoldStatuses.ACTIVE, expiresAt: "2026-08-05T09:00:00.000Z" },
      NOW,
    );

    expect(decision).toMatchObject({ detail: { expiresAt: "2026-08-05T09:00:00.000Z" } });
  });
});

describe("holdRemainingSeconds", () => {
  it("counts down to the deadline", () => {
    expect(holdRemainingSeconds({ expiresAt: "2026-08-05T10:04:38.000Z" }, NOW)).toBe(278);
  });

  it("never goes negative", () => {
    // The booking page renders this as "reserved for 0:00", not "-1:23".
    expect(holdRemainingSeconds({ expiresAt: "2026-08-05T09:00:00.000Z" }, NOW)).toBe(0);
  });

  it("rounds a part-second up, so a live hold never reads as zero", () => {
    expect(holdRemainingSeconds({ expiresAt: "2026-08-05T10:00:00.400Z" }, NOW)).toBe(1);
  });
});

describe("checkHoldReleasable", () => {
  it("allows releasing a hold that is already released or expired", () => {
    // The customer pressed back twice, or the request was retried. Not worth an
    // error either time.
    expect(checkHoldReleasable({ status: HoldStatuses.ACTIVE }).allowed).toBe(true);
    expect(checkHoldReleasable({ status: HoldStatuses.RELEASED }).allowed).toBe(true);
    expect(checkHoldReleasable({ status: HoldStatuses.EXPIRED }).allowed).toBe(true);
  });

  it("refuses to release a hold that became a booking", () => {
    // Releasing this would free a slot somebody holds a confirmation for.
    expect(checkHoldReleasable({ status: HoldStatuses.CONFIRMED })).toMatchObject({
      allowed: false,
      reason: "HOLD_ALREADY_CONFIRMED",
    });
  });
});
