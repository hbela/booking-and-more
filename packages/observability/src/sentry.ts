import * as Sentry from "@sentry/node";
import { getRequestContext } from "./request-context.js";
import { redactSecretBearingValues } from "./url-redaction.js";

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

    beforeSend(event) {
      event = redactSecretBearingValues(event);
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

export async function flushSentry(timeoutMs = 2_000): Promise<void> {
  if (!initialised) return;
  await Sentry.flush(timeoutMs);
}

export { Sentry };
