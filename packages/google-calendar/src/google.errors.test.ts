import { describe, expect, it } from "vitest";
import {
  classifyGoogleFailure,
  classifyUnknown,
  GoogleApiError,
  GoogleFailureKinds,
  googleBackoffMs,
  isGoogleApiError,
  needsReconnect,
} from "./google.errors.js";

/**
 * tech-impl §26.3, as a table.
 *
 * Every row here is a decision about somebody's diary: retry the wrong thing and
 * the attempt budget burns against a wall; park the wrong thing and a provider's
 * calendar silently stops updating.
 */

const kind = (signal: Parameters<typeof classifyGoogleFailure>[0]) =>
  classifyGoogleFailure(signal).kind;

describe("classifyGoogleFailure", () => {
  it("retries a transport failure with no response", () => {
    // The request may or may not have reached Google, which is exactly why every
    // write in this package is idempotent.
    expect(kind({ code: "ECONNRESET" })).toBe(GoogleFailureKinds.RETRY);
    expect(kind({ code: "UND_ERR_CONNECT_TIMEOUT" })).toBe(GoogleFailureKinds.RETRY);
    expect(kind({})).toBe(GoogleFailureKinds.RETRY);
  });

  describe("403 is not one thing", () => {
    // The row that earns this whole file. Both arrive as 403 and they are
    // opposites.
    it("retries a rate limit", () => {
      expect(kind({ status: 403, reason: "rateLimitExceeded" })).toBe(GoogleFailureKinds.RETRY);
      expect(kind({ status: 403, reason: "userRateLimitExceeded" })).toBe(
        GoogleFailureKinds.RETRY,
      );
    });

    it("never retries a permission failure", () => {
      expect(kind({ status: 403, reason: "insufficientPermissions" })).toBe(
        GoogleFailureKinds.RECONNECT,
      );
      expect(kind({ status: 403, reason: "forbidden" })).toBe(GoogleFailureKinds.RECONNECT);
    });

    it("reads an unrecognised 403 as permission", () => {
      // The safer default: a wrongly-parked row is visible on the integrations
      // screen and a human can fix it, while a wrongly-retried permission error
      // is invisible and infinite.
      expect(kind({ status: 403, reason: "somethingNew" })).toBe(GoogleFailureKinds.RECONNECT);
    });
  });

  it("treats invalid_grant as a reconnection even though it is a 400", () => {
    // The ordering trap: reason is checked before status. Read as a plain 400
    // this would park; read as transient it would retry a revoked token forever.
    // It is neither — it is the signal that a human must re-consent.
    expect(kind({ status: 400, reason: "invalid_grant" })).toBe(GoogleFailureKinds.RECONNECT);
    expect(needsReconnect(kind({ status: 400, reason: "invalid_grant" }))).toBe(true);
  });

  it.each([
    [401, undefined, GoogleFailureKinds.RECONNECT],
    [429, undefined, GoogleFailureKinds.RETRY],
    [500, undefined, GoogleFailureKinds.RETRY],
    [502, undefined, GoogleFailureKinds.RETRY],
    [503, undefined, GoogleFailureKinds.RETRY],
    [409, "duplicate", GoogleFailureKinds.ALREADY_EXISTS],
    [410, undefined, GoogleFailureKinds.RECREATE],
    [404, "notFound", GoogleFailureKinds.PARK],
    [400, "invalid", GoogleFailureKinds.PARK],
    [400, undefined, GoogleFailureKinds.PARK],
  ])("classifies %s/%s", (status, reason, expected) => {
    expect(kind({ status, ...(reason === undefined ? {} : { reason }) })).toBe(expected);
  });

  it("reads a 409 as success, not failure", () => {
    // The 409 is what makes the derived event id an idempotency mechanism
    // (§2.3): Google already has this exact event, so there is nothing to do.
    expect(kind({ status: 409 })).toBe(GoogleFailureKinds.ALREADY_EXISTS);
  });

  it("recreates rather than accepting a deletion", () => {
    // Somebody deleted our event in Google. The database is authoritative
    // (PRD §9.10), so the appointment goes back.
    expect(kind({ status: 410, reason: "deleted" })).toBe(GoogleFailureKinds.RECREATE);
  });

  it("carries a reason that is safe to store", () => {
    // `last_error` is read on the integrations screen and shipped in logs.
    const classification = classifyGoogleFailure({ status: 403, reason: "rateLimitExceeded" });

    expect(classification.reason).toBe("rateLimitExceeded");
    expect(classifyGoogleFailure({ status: 503 }).reason).toBe("http 503");
  });
});

describe("classifyUnknown", () => {
  it("unwraps a GoogleApiError", () => {
    const error = new GoogleApiError("boom", { status: 401 });

    expect(isGoogleApiError(error)).toBe(true);
    expect(classifyUnknown(error).kind).toBe(GoogleFailureKinds.RECONNECT);
  });

  it("retries anything else that reaches a catch block", () => {
    expect(classifyUnknown(new Error("who knows")).kind).toBe(GoogleFailureKinds.RETRY);
    expect(classifyUnknown(undefined).kind).toBe(GoogleFailureKinds.RETRY);
  });

  it("recognises a Google error across a bundle boundary", () => {
    // Duck-typed for the same reason `isAppError` is: `instanceof` does not
    // survive being bundled twice.
    const lookalike = { isGoogleApiError: true, signal: { status: 429 } };

    expect(isGoogleApiError(lookalike)).toBe(true);
    expect(classifyUnknown(lookalike).kind).toBe(GoogleFailureKinds.RETRY);
  });
});

describe("googleBackoffMs", () => {
  it("grows with the attempt and stays bounded", () => {
    const noJitter = () => 1;

    expect(googleBackoffMs(1, noJitter)).toBe(30_000);
    expect(googleBackoffMs(2, noJitter)).toBe(60_000);
    expect(googleBackoffMs(3, noJitter)).toBe(120_000);
    expect(googleBackoffMs(50, noJitter)).toBe(60 * 60 * 1_000);
  });

  it("jitters", () => {
    // Not decoration: Google 429s every caller at once, so a fleet retrying on
    // identical delays rebuilds the burst that caused it.
    expect(googleBackoffMs(3, () => 0.5)).toBe(60_000);
    expect(googleBackoffMs(3, () => 1)).toBe(120_000);
  });

  it("never returns a delay short enough to spin", () => {
    expect(googleBackoffMs(1, () => 0)).toBe(1_000);
    expect(googleBackoffMs(0, () => 0)).toBe(1_000);
  });
});
