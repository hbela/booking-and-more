import { describe, expect, it } from "vitest";

import { backoffDelayMs, classifyFailure, decideRetry, FailureKinds } from "./retry.js";

describe("classifyFailure", () => {
  // tech-impl §26.3 lists these explicitly as retryable.
  it.each([429, 500, 502, 503, 504, 408])("treats HTTP %i as transient", (statusCode) => {
    expect(classifyFailure({ statusCode }).kind).toBe(FailureKinds.TRANSIENT);
  });

  // …and these as needing a human.
  it.each([400, 401, 403, 404, 422])("treats HTTP %i as permanent", (statusCode) => {
    expect(classifyFailure({ statusCode }).kind).toBe(FailureKinds.PERMANENT);
  });

  it.each(["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "EAI_AGAIN", "UND_ERR_SOCKET"])(
    "treats the network failure %s as transient",
    (code) => {
      expect(classifyFailure({ code }).kind).toBe(FailureKinds.TRANSIENT);
    },
  );

  it.each([
    "invalid_recipient",
    "permission_denied",
    "oauth_access_revoked",
    "invalid_calendar_id",
  ])("treats the provider condition %s as permanent", (code) => {
    expect(classifyFailure({ code }).kind).toBe(FailureKinds.PERMANENT);
  });

  it("lets a permanent provider code override an otherwise transient status", () => {
    // Providers return 500s with a body explaining the request was invalid.
    // The code is the more specific signal, so it wins.
    const result = classifyFailure({ statusCode: 500, code: "invalid_recipient" });
    expect(result.kind).toBe(FailureKinds.PERMANENT);
  });

  it("treats an unrecognised failure as transient", () => {
    // Deliberate: an unknown failure wrongly called permanent silently loses a
    // confirmation, whereas one wrongly called transient costs a few attempts.
    expect(classifyFailure({}).kind).toBe(FailureKinds.TRANSIENT);
    expect(classifyFailure({ code: "something_new" }).kind).toBe(FailureKinds.TRANSIENT);
  });

  it("explains itself in a form fit for last_error", () => {
    expect(classifyFailure({ statusCode: 429 }).reason).toContain("429");
    expect(classifyFailure({ code: "invalid_recipient" }).reason).toContain("invalid_recipient");
  });
});

describe("decideRetry", () => {
  it("retries a transient failure with attempts remaining", () => {
    const decision = decideRetry({ signal: { statusCode: 503 }, attempts: 1, maxAttempts: 5 });
    expect(decision.retry).toBe(true);
  });

  it("does not retry a permanent failure even on the first attempt", () => {
    const decision = decideRetry({
      signal: { code: "invalid_recipient" },
      attempts: 1,
      maxAttempts: 5,
    });

    expect(decision.retry).toBe(false);
    expect(decision.reason).toContain("invalid_recipient");
  });

  it("gives up on a transient failure once attempts are exhausted", () => {
    const decision = decideRetry({ signal: { statusCode: 503 }, attempts: 5, maxAttempts: 5 });

    expect(decision.retry).toBe(false);
    expect(decision.reason).toContain("exhausted");
  });

  it("does not retry past the ceiling even if attempts overshoot it", () => {
    const decision = decideRetry({ signal: { statusCode: 503 }, attempts: 9, maxAttempts: 5 });
    expect(decision.retry).toBe(false);
  });
});

describe("backoffDelayMs", () => {
  const always = (value: number) => () => value;

  it("grows exponentially at the top of its jitter range", () => {
    const first = backoffDelayMs({ attempt: 1, baseMs: 1_000, random: always(0.999_999) });
    const second = backoffDelayMs({ attempt: 2, baseMs: 1_000, random: always(0.999_999) });
    const third = backoffDelayMs({ attempt: 3, baseMs: 1_000, random: always(0.999_999) });

    expect(second).toBeGreaterThan(first);
    expect(third).toBeGreaterThan(second);
    expect(third).toBeLessThanOrEqual(4_000);
  });

  it("jitters: the same attempt yields different delays", () => {
    // The point is that a batch failing together does not march back in
    // lockstep exactly as the provider recovers.
    const low = backoffDelayMs({ attempt: 4, baseMs: 1_000, random: always(0.1) });
    const high = backoffDelayMs({ attempt: 4, baseMs: 1_000, random: always(0.9) });

    expect(low).not.toBe(high);
    expect(low).toBeLessThan(high);
  });

  it("never exceeds the cap", () => {
    const delay = backoffDelayMs({
      attempt: 20,
      baseMs: 1_000,
      maxMs: 60_000,
      random: always(0.999_999),
    });

    expect(delay).toBeLessThanOrEqual(60_000);
  });

  it("stays finite for an absurd attempt count", () => {
    // 2 ** 1024 is Infinity, and Infinity * a fraction is NaN — which would
    // surface as a job scheduled at an invalid time rather than a wrong delay.
    const delay = backoffDelayMs({ attempt: 5_000, baseMs: 1_000, random: always(0.5) });

    expect(Number.isFinite(delay)).toBe(true);
    expect(delay).toBeGreaterThanOrEqual(0);
  });

  it("is never negative", () => {
    expect(backoffDelayMs({ attempt: 0, baseMs: 1_000, random: always(0) })).toBe(0);
    expect(backoffDelayMs({ attempt: -3, baseMs: 1_000, random: always(0) })).toBe(0);
  });
});
