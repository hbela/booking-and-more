/**
 * Whether a failed delivery is worth trying again, and when. tech-impl §26.3.
 *
 * The distinction the spec draws is between a failure the world will fix on its
 * own — a rate limit, a five-hundred, a socket that dropped — and one that will
 * fail identically forever until a person intervenes. Retrying the second kind
 * is not merely wasted work: it buries the real failure under noise and, for
 * an invalid recipient, repeatedly asks the provider to deliver to an address
 * that will never accept it, which is how a sending domain earns a reputation
 * problem.
 */

export const FailureKinds = {
  /** Will plausibly succeed later, unchanged. Retry with backoff. */
  TRANSIENT: "TRANSIENT",
  /** Will fail identically until someone changes something. Do not retry. */
  PERMANENT: "PERMANENT",
} as const;

export type FailureKind = (typeof FailureKinds)[keyof typeof FailureKinds];

/**
 * What a caller managed to learn about a failure. Every field is optional
 * because provider SDKs are inconsistent about which they populate, and a
 * classifier that demands a complete signal is one that throws inside an error
 * handler.
 */
export interface FailureSignal {
  /** HTTP status, when the failure came back as a response. */
  statusCode?: number | undefined;
  /** A Node `error.code` (`ECONNRESET`) or a provider's own code. */
  code?: string | undefined;
}

export interface FailureClassification {
  kind: FailureKind;
  /** Convenience mirror of `kind` — the thing every caller actually branches on. */
  retryable: boolean;
  /** Why, in a form fit for a log line and a `last_error` column. */
  reason: string;
}

/**
 * Socket-level failures. Each of these means "the message did not arrive",
 * which is exactly the situation retrying exists for.
 *
 * `ENOTFOUND` is here despite looking permanent: in practice it is DNS being
 * briefly unavailable far more often than it is a genuinely wrong hostname,
 * and a wrong hostname is caught by the attempt ceiling within a minute.
 */
const TRANSIENT_ERROR_CODES = new Set([
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EAI_AGAIN",
  "ENOTFOUND",
  "EPIPE",
  "ESOCKETTIMEDOUT",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
]);

/**
 * Provider-reported conditions that no amount of waiting resolves. The names
 * are the ones §26.3 lists, plus the Resend equivalents.
 */
const PERMANENT_ERROR_CODES = new Set([
  "invalid_recipient",
  "invalid_from_address",
  "invalid_parameter",
  "missing_required_field",
  "permission_denied",
  "restricted_api_key",
  "validation_error",
  "oauth_access_revoked",
  "invalid_calendar_id",
]);

export function classifyFailure(signal: FailureSignal): FailureClassification {
  const code = signal.code?.toLowerCase();

  if (code !== undefined) {
    if (PERMANENT_ERROR_CODES.has(code)) {
      return permanent(`provider reported ${code}`);
    }
    // Node's codes are upper-case; compare in their own case rather than
    // lower-casing the set and losing the distinction from provider codes.
    if (TRANSIENT_ERROR_CODES.has(signal.code ?? "")) {
      return transient(`network failure ${signal.code ?? ""}`);
    }
  }

  const status = signal.statusCode;

  if (status !== undefined) {
    if (status === 408 || status === 429) {
      return transient(`HTTP ${String(status)}`);
    }
    if (status >= 500) {
      return transient(`HTTP ${String(status)}`);
    }
    if (status >= 400) {
      // 401, 403, 404, 422 and friends. Every one of them needs a human.
      return permanent(`HTTP ${String(status)}`);
    }
  }

  // Nothing recognisable. Treated as transient on purpose: an unrecognised
  // failure that is really permanent costs a handful of attempts before the
  // ceiling parks it, whereas an unrecognised failure wrongly called permanent
  // silently loses a confirmation the customer is waiting for.
  return transient("unclassified failure");
}

function transient(reason: string): FailureClassification {
  return { kind: FailureKinds.TRANSIENT, retryable: true, reason };
}

function permanent(reason: string): FailureClassification {
  return { kind: FailureKinds.PERMANENT, retryable: false, reason };
}

export interface RetryDecisionInput {
  signal: FailureSignal;
  /** Attempts already made, including the one that just failed. */
  attempts: number;
  maxAttempts: number;
}

export interface RetryDecision {
  retry: boolean;
  classification: FailureClassification;
  /** Why the job is being given up on, when it is. */
  reason: string;
}

/** Retry only a transient failure, and only while attempts remain. */
export function decideRetry(input: RetryDecisionInput): RetryDecision {
  const classification = classifyFailure(input.signal);

  if (!classification.retryable) {
    return { retry: false, classification, reason: classification.reason };
  }

  if (input.attempts >= input.maxAttempts) {
    return {
      retry: false,
      classification,
      reason: `exhausted after ${String(input.attempts)} attempts: ${classification.reason}`,
    };
  }

  return { retry: true, classification, reason: classification.reason };
}

export interface BackoffOptions {
  /** Attempts already made. The first retry is attempt 1. */
  attempt: number;
  baseMs?: number;
  maxMs?: number;
  /**
   * Injected so the function stays pure and its tests stay deterministic.
   * Expected to return a value in [0, 1).
   */
  random?: () => number;
}

const DEFAULT_BASE_MS = 5_000;
const DEFAULT_MAX_MS = 30 * 60 * 1_000;

/**
 * Exponential backoff with full jitter.
 *
 * Full jitter rather than a fixed doubling because every job in a batch fails
 * at the same moment when a provider goes down, and undithered backoff marches
 * them all back in lockstep — the retry storm arrives exactly as the provider
 * is recovering.
 */
export function backoffDelayMs(options: BackoffOptions): number {
  const base = options.baseMs ?? DEFAULT_BASE_MS;
  const max = options.maxMs ?? DEFAULT_MAX_MS;
  const random = options.random ?? Math.random;

  const attempt = Math.max(1, Math.floor(options.attempt));
  // Cap the exponent before computing the power: 2 ** 1024 is Infinity, and
  // Infinity * a fraction is NaN, which would surface as a job scheduled at an
  // invalid time rather than as an obviously wrong delay.
  const exponent = Math.min(attempt - 1, 30);
  const ceiling = Math.min(base * 2 ** exponent, max);

  return Math.round(random() * ceiling);
}
