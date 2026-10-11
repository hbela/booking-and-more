import { scrubTelemetry } from "./sentry-scrubbing.js";

/**
 * Browser-safe guards around Sentry's hooks; never imports the Node SDK.
 *
 * Both exist because the free plan has no per-key rate limit, and a scrubber
 * that threw inside `beforeSend` once reported its own failure about every ten
 * seconds until the month's error quota was gone (BOOKING-AND-MORE-FASTIFY-2).
 */

/**
 * Scrub, or drop when scrubbing fails. Returning the input unscrubbed would
 * trade a lost event for a leaked one, and letting the error escape makes the
 * SDK report it — which is how one bug became 10K events.
 */
export function scrubOrDrop<T>(value: T): T | null {
  try {
    return scrubTelemetry(value);
  } catch {
    return null;
  }
}

export interface BudgetedEvent {
  message?: string | undefined;
  exception?: { values?: { type?: string | undefined; value?: string | undefined }[] | undefined };
}

export interface EventBudgetOptions {
  /** Identical errors allowed per minute. */
  perKeyPerMinute?: number;
  /** All errors allowed per hour, across keys. */
  perHour?: number;
  now?: () => number;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/**
 * A per-process error budget: what the Business plan's DSN rate limit would
 * do, done client-side. Fixed windows rather than sliding ones — the point is a
 * ceiling on a runaway loop, not an even rate. A real outage arrives as a
 * sample, which is enough to alert on.
 */
export function createEventBudget(
  options: EventBudgetOptions = {},
): (event: BudgetedEvent) => boolean {
  const perKeyPerMinute = options.perKeyPerMinute ?? 3;
  const perHour = options.perHour ?? 50;
  const now = options.now ?? Date.now;

  let hourStart = now();
  let hourCount = 0;
  let minuteStart = hourStart;
  // Cleared every minute, so a stream of distinct messages cannot grow it
  // beyond one minute's worth — and the hourly cap bounds that too.
  let perKey = new Map<string, number>();

  return (event) => {
    const time = now();
    if (time - hourStart >= HOUR_MS) {
      hourStart = time;
      hourCount = 0;
    }
    if (time - minuteStart >= MINUTE_MS) {
      minuteStart = time;
      perKey = new Map();
    }
    if (hourCount >= perHour) return false;

    const key = budgetKey(event);
    const seen = perKey.get(key) ?? 0;
    if (seen >= perKeyPerMinute) return false;

    perKey.set(key, seen + 1);
    hourCount += 1;
    return true;
  };
}

function budgetKey(event: BudgetedEvent): string {
  const first = event.exception?.values?.[0];
  if (first) return `${first.type ?? ""}:${first.value ?? ""}`;
  return event.message ?? "";
}
