import {
  type BudgetedEvent,
  createEventBudget,
  scrubOrDrop,
} from "@bam/observability/sentry-guard";

// One budget per runtime (browser tab, Node server, edge isolate): each config
// file imports this module once.
const withinBudget = createEventBudget();

export const privacyOptions = {
  sendDefaultPii: false,
  tracesSampleRate: 0.1,
  beforeSend: <T extends BudgetedEvent>(event: T): T | null =>
    withinBudget(event) ? scrubOrDrop(event) : null,
  beforeSendTransaction: scrubOrDrop,
  beforeBreadcrumb: scrubOrDrop,
};

/** Anchor both scheme and authority so trace headers never reach lookalike hosts. */
export function apiTraceTarget(origin: string): RegExp {
  const normalized = new URL(origin).origin;
  return new RegExp(`^${normalized.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}(?:/|$)`);
}
