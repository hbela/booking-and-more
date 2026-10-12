import * as Sentry from "@sentry/node";
import { getRequestContext } from "./request-context.js";
import { createEventBudget, scrubOrDrop } from "./sentry-guard.js";

export interface InitSentryOptions {
  dsn?: string | undefined;
  environment: string;
  /** "api" | "worker" | "web" — becomes the `service` tag. */
  service: string;
  release?: string | undefined;
  tracesSampleRate?: number;
}

let initialised = false;

/**
 * Initialise Sentry, if a DSN is configured.
 *
 * An absent DSN is a valid state, not an error: local development and CI run
 * without one. This follows CLAUDE.md rule 4 — a missing key degrades one
 * feature rather than crashing boot.
 *
 * Import the module that calls this *first* in the entry point, before Fastify
 * or Prisma, so Sentry's auto-instrumentation can patch them.
 */
export function initSentry(options: InitSentryOptions): boolean {
  const { dsn, environment, service, release, tracesSampleRate } = options;

  if (!dsn) return false;
  if (initialised) return true;

  const withinBudget = createEventBudget();

  Sentry.init({
    dsn,
    environment,
    ...(release === undefined ? {} : { release }),
    // Sampled in production; full tracing elsewhere where volume is trivial.
    tracesSampleRate: tracesSampleRate ?? (environment === "production" ? 0.1 : 1.0),

    // Do not send PII. tech-impl §36.3: attach tenant and request context, never
    // customer content.
    sendDefaultPii: false,

    initialScope: { tags: { service } },
    beforeSendTransaction: scrubOrDrop,
    beforeBreadcrumb: scrubOrDrop,

    beforeSend(event) {
      if (!withinBudget(event)) return null;
      // scrubTelemetry's string rules already cover the management-token path
      // that redactSecretBearingValues handles for the logger.
      const scrubbed = scrubOrDrop(event);
      if (!scrubbed) return null;
      event = scrubbed;
      const context = getRequestContext();
      if (!context) return event;

      event.tags = {
        ...event.tags,
        requestId: context.requestId,
        ...(context.tenantId === undefined ? {} : { tenantId: context.tenantId }),
      };

      // Only the ID — never an email or name (tech-impl §36.3).
      if (context.userId !== undefined) {
        event.user = { id: context.userId };
      }

      return event;
    },
  });

  initialised = true;
  return true;
}

export function isSentryEnabled(): boolean {
  return initialised;
}

/**
 * Report an exception. A no-op when Sentry is not configured, so call sites do
 * not need to branch.
 */
export function captureException(error: unknown, context?: Record<string, unknown>): void {
  if (!initialised) return;
  Sentry.captureException(error, context ? { extra: context } : undefined);
}

export interface HeartbeatMonitor {
  /** Stable across deploys: Sentry keys the monitor, and its history, on it. */
  slug: string;
  intervalMinutes: number;
}

/**
 * Check in to a Sentry cron monitor, creating or updating it from this config
 * on the way. Its schedule therefore lives in code rather than in the Sentry
 * UI. A no-op without a DSN, like every other export here.
 *
 * `status: "error"` means the process is alive but not doing its job; it opens
 * an issue on the same thresholds as a missed check-in.
 *
 * The thresholds are chosen around deploys: a container restart misses a
 * check-in or two, so the monitor waits out a margin and then needs two
 * consecutive misses before it opens an issue.
 */
export function reportHeartbeat(monitor: HeartbeatMonitor, status: "ok" | "error" = "ok"): void {
  if (!initialised) return;
  Sentry.captureCheckIn(
    { monitorSlug: monitor.slug, status },
    {
      schedule: { type: "interval", value: monitor.intervalMinutes, unit: "minute" },
      checkinMargin: 3,
      maxRuntime: 1,
      failureIssueThreshold: 2,
      recoveryThreshold: 1,
    },
  );
}

export async function flushSentry(timeoutMs = 2_000): Promise<void> {
  if (!initialised) return;
  await Sentry.flush(timeoutMs);
}

export { Sentry };
