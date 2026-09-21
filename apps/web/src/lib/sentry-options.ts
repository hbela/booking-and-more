import { scrubTelemetry } from "@bam/observability/sentry-scrubbing";

export const privacyOptions = {
  sendDefaultPii: false,
  tracesSampleRate: 0.1,
  beforeSend: scrubTelemetry,
  beforeSendTransaction: scrubTelemetry,
  beforeBreadcrumb: scrubTelemetry,
};

/** Anchor both scheme and authority so trace headers never reach lookalike hosts. */
export function apiTraceTarget(origin: string): RegExp {
  const normalized = new URL(origin).origin;
  return new RegExp(`^${normalized.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}(?:/|$)`);
}
