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
  /** All errors allowed per day, across keys. */
  perDay?: number;
  now?: () => number;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * A per-process error budget: what the Business plan's DSN rate limit would
 * do, done client-side. Fixed windows rather than sliding ones — the point is a
 * ceiling on a runaway loop, not an even rate. A real outage arrives as a
 * sample, which is enough to alert on.
 *
 * The daily cap is what keeps the month inside the free plan's ~5,000 errors.
 * Each runtime has its own budget — per environment the API, the worker, the
 * Next.js server and its edge runtime — so staging and production together run
 * eight, and 8 × 20 × 30 = 4,800. A restart starts a fresh budget, and a
 * browser tab has its own, so neither is bounded by this; only Sentry's
 * server-side limits, which the free plan lacks, could be.
 */
export function createEventBudget(
  options: EventBudgetOptions = {},
): (event: BudgetedEvent) => boolean {
  const perKeyPerMinute = options.perKeyPerMinute ?? 3;
  const perHour = options.perHour ?? 10;
  const perDay = options.perDay ?? 20;
  const now = options.now ?? Date.now;

  let dayStart = now();
  let dayCount = 0;
  let hourStart = dayStart;
  let hourCount = 0;
  let minuteStart = hourStart;
  // Cleared every minute, so a stream of distinct messages cannot grow it
  // beyond one minute's worth — and the hourly cap bounds that too.
  let perKey = new Map<string, number>();

  return (event) => {
    const time = now();
    if (time - dayStart >= DAY_MS) {
      dayStart = time;
      dayCount = 0;
    }
    if (time - hourStart >= HOUR_MS) {
      hourStart = time;
      hourCount = 0;
    }
    if (time - minuteStart >= MINUTE_MS) {
      minuteStart = time;
      perKey = new Map();
    }
    if (hourCount >= perHour || dayCount >= perDay) return false;

    const key = budgetKey(event);
    const seen = perKey.get(key) ?? 0;
    if (seen >= perKeyPerMinute) return false;

    perKey.set(key, seen + 1);
    hourCount += 1;
    dayCount += 1;
    return true;
  };
}

function budgetKey(event: BudgetedEvent): string {
  const first = event.exception?.values?.[0];
  if (first) return `${first.type ?? ""}:${first.value ?? ""}`;
  return event.message ?? "";
}
