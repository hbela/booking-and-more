/**
 * What a Google failure means, and whether to try again. tech-impl §26.3.
 *
 * A pure function of a status code and a reason string, so the whole retry
 * policy is testable as a table rather than by provoking Google — the same split
 * @bam/notification-engine's `classifyFailure` makes for Resend, and the reason
 * this package hand-rolls `fetch` rather than taking `googleapis`: an SDK error
 * class flattens exactly the two fields this needs
 * (docs/phase-6-google-calendar-part-1.md §2.7).
 *
 * ## The one that catches people out
 *
 * **403 is not one thing.** `rateLimitExceeded` and `userRateLimitExceeded` mean
 * "you are going too fast" and must be retried; `insufficientPermissions`,
 * `forbidden` and `authError` mean "you may not do this at all" and must never
 * be. Treating the whole status as retryable burns the attempt budget against a
 * wall; treating it as permanent parks a provider's diary over a momentary
 * spike. Both have happened to somebody.
 */

export const GoogleFailureKinds = {
  /** Transient. Back off and try again. */
  RETRY: "RETRY",
  /**
   * The grant is gone. Nothing retries — a human must re-consent, and the
   * integration moves to NEEDS_RECONNECT and earns a CALENDAR_DISCONNECTED
   * email. §26.3's "OAuth access revoked".
   */
  RECONNECT: "RECONNECT",
  /**
   * Permanently wrong, but not about authorization: a calendar id that does not
   * exist, a malformed request. §26.3's "Invalid calendar ID". Parks the row
   * and, where the calendar itself is gone, deactivates the mapping.
   */
  PARK: "PARK",
  /**
   * Not a failure at all. Google already has this event — the 409 that makes
   * the derived event id an idempotency mechanism (§2.3).
   */
  ALREADY_EXISTS: "ALREADY_EXISTS",
  /**
   * The event we meant to patch is gone: somebody deleted it in Google. The
   * database is authoritative (PRD §9.10), so the answer is to create it again
   * rather than to accept the deletion.
   */
  RECREATE: "RECREATE",
} as const;

export type GoogleFailureKind = (typeof GoogleFailureKinds)[keyof typeof GoogleFailureKinds];

export interface GoogleFailureSignal {
  /** Absent for a transport error — no response ever arrived. */
  status?: number | undefined;
  /** Google's `error.errors[0].reason`, or the OAuth endpoint's `error`. */
  reason?: string | undefined;
  /** A Node error code — `ECONNRESET`, `ETIMEDOUT`, `UND_ERR_CONNECT_TIMEOUT`. */
  code?: string | undefined;
}

export interface GoogleFailureClassification {
  kind: GoogleFailureKind;
  /** Short, stable, and safe to store in `last_error`. Never contains a token. */
  reason: string;
}

/**
 * Reasons that mean the grant itself is gone, whatever the status says.
 *
 * `invalid_grant` is the important one and it arrives as a **400** from the
 * token endpoint, not a 401 — which is why this is checked before the status
 * code. Reading it as a transient 400 would retry a revoked token forever.
 */
const RECONNECT_REASONS = new Set([
  "invalid_grant",
  "invalid_token",
  "unauthorized_client",
  "insufficientPermissions",
  "authError",
  "forbidden",
]);

/** 403s that are about speed rather than permission. */
const RATE_LIMIT_REASONS = new Set([
  "rateLimitExceeded",
  "userRateLimitExceeded",
  "quotaExceeded",
  "backendError",
]);

/** Reasons that mean the request will never work as written. */
const PARK_REASONS = new Set([
  "notFound",
  "invalid",
  "invalidParameter",
  "required",
  "badRequest",
  "invalidSharingRequest",
]);

export function classifyGoogleFailure(signal: GoogleFailureSignal): GoogleFailureClassification {
  const { status, reason, code } = signal;

  // No response at all: DNS, a reset connection, a timeout. Always transient —
  // the request may or may not have reached Google, which is precisely why
  // every write here is idempotent (§2.3).
  if (status === undefined) {
    return { kind: GoogleFailureKinds.RETRY, reason: code ?? "network error" };
  }

  // Reason before status, deliberately. `invalid_grant` is a 400 and a 400 is
  // otherwise permanent-but-not-auth; getting this order wrong means a revoked
  // token is retried to exhaustion and never reported as a disconnection.
  if (reason !== undefined && RECONNECT_REASONS.has(reason)) {
    return { kind: GoogleFailureKinds.RECONNECT, reason };
  }

  if (reason !== undefined && RATE_LIMIT_REASONS.has(reason)) {
    return { kind: GoogleFailureKinds.RETRY, reason };
  }

  if (status === 409 || reason === "duplicate") {
    return { kind: GoogleFailureKinds.ALREADY_EXISTS, reason: reason ?? "duplicate" };
  }

  // 410 Gone on a patch: the event was deleted in Google. 404 on an *event* is
  // the same situation reported differently, but 404 on a *calendar* is a
  // parked mapping — the caller knows which it asked for and passes the reason
  // through, so `notFound` lands in PARK below and the event path checks 410.
  if (status === 410) {
    return { kind: GoogleFailureKinds.RECREATE, reason: reason ?? "gone" };
  }

  if (status === 401) {
    return { kind: GoogleFailureKinds.RECONNECT, reason: reason ?? "unauthorized" };
  }

  // A 403 with no reason we recognise. Permission is the safer reading: a
  // wrongly-parked row is visible on the integrations screen and fixable by a
  // human, while a wrongly-retried permission error is invisible and infinite.
  if (status === 403) {
    return { kind: GoogleFailureKinds.RECONNECT, reason: reason ?? "forbidden" };
  }

  if (status === 429) {
    return { kind: GoogleFailureKinds.RETRY, reason: reason ?? "rateLimitExceeded" };
  }

  if (status >= 500) {
    return { kind: GoogleFailureKinds.RETRY, reason: reason ?? `http ${String(status)}` };
  }

  if (reason !== undefined && PARK_REASONS.has(reason)) {
    return { kind: GoogleFailureKinds.PARK, reason };
  }

  // Any other 4xx. Permanent by default: a client error that we do not
  // recognise will not be fixed by sending it again.
  if (status >= 400) {
    return { kind: GoogleFailureKinds.PARK, reason: reason ?? `http ${String(status)}` };
  }

  // Not a failure shape at all. Retrying is the conservative answer.
  return { kind: GoogleFailureKinds.RETRY, reason: reason ?? `http ${String(status)}` };
}

/** Does this classification mean the integration needs a human? */
export function needsReconnect(kind: GoogleFailureKind): boolean {
  return kind === GoogleFailureKinds.RECONNECT;
}

/**
 * Exponential backoff with jitter, in milliseconds.
 *
 * Jitter is not decoration here. When Google returns 429 it usually does so to
 * every request at once, so a fleet retrying on identical delays reconstructs
 * the burst that caused it. Full jitter is the standard answer and costs one
 * `Math.random()`.
 *
 * Deliberately longer than @bam/notification-engine's `backoffDelayMs`: an email
 * provider's blip is seconds, a Google incident is minutes, and the row is
 * durable either way.
 */
export function googleBackoffMs(attempt: number, random: () => number = Math.random): number {
  const BASE_MS = 30_000;
  const CEILING_MS = 60 * 60 * 1_000;

  const exponential = Math.min(BASE_MS * 2 ** Math.max(0, attempt - 1), CEILING_MS);

  // Full jitter, floored at a second so a caller cannot spin on a zero delay.
  return Math.max(1_000, Math.floor(random() * exponential));
}

/**
 * An error carrying enough for {@link classifyGoogleFailure} to decide.
 *
 * A class rather than a bare object so it survives a `throw` through the
 * `fetch` layer, and duck-typed by `isGoogleApiError` for the same reason
 * `isAppError` is: `instanceof` does not survive a bundle boundary.
 */
export class GoogleApiError extends Error {
  public readonly isGoogleApiError = true;

  constructor(
    message: string,
    public readonly signal: GoogleFailureSignal,
  ) {
    super(message);
    this.name = "GoogleApiError";
  }
}

export function isGoogleApiError(error: unknown): error is GoogleApiError {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { isGoogleApiError?: unknown }).isGoogleApiError === true
  );
}

/** Classify anything that reaches a catch block, Google-shaped or not. */
export function classifyUnknown(error: unknown): GoogleFailureClassification {
  if (isGoogleApiError(error)) return classifyGoogleFailure(error.signal);

  const code = (error as { code?: unknown } | null)?.code;

  return classifyGoogleFailure({
    ...(typeof code === "string" ? { code } : {}),
  });
}
