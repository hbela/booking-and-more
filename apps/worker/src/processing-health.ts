import type { PrismaClient } from "@bam/db";
import type { Logger } from "@bam/observability";

/** Work still waiting this long after it was due is stuck, not slow. */
const OVERDUE_MS = 5 * 60_000;

/**
 * How long a failure keeps the heartbeat red. A failure is an instant, and the
 * cron monitor opens an issue only after two consecutive error check-ins, so a
 * failure reported for one minute would never reach anybody. Thirty minutes is
 * long enough to alert and short enough to recover on its own.
 */
const RECENT_FAILURE_MS = 30 * 60_000;

/**
 * A Stripe event the processor cannot attribute yet is retried on purpose
 * until `STRIPE_EVENT_ORPHAN_TIMEOUT_MS`, then retired — its sibling event may
 * still be on the way. Inside that window it is waiting, not stuck: alarming at
 * five minutes turned every cancelled test subscription into a red monitor.
 * Past the window plus the usual margin, nothing legitimate is left.
 */
const DEFAULT_STRIPE_ORPHAN_TIMEOUT_MS = 15 * 60_000;

/** A probe that cannot answer is an answer: the worker cannot reach its work. */
const PROBE_TIMEOUT_MS = 10_000;

export type ProcessingStatus = "ok" | "error";

export interface ProcessingMetrics {
  outboxOverdue: number;
  outboxRecentlyFailed: number;
  notificationsOverdue: number;
  notificationsRecentlyFailed: number;
  stripeOverdue: number;
  /** Totals, for the log only: rows stay FAILED, so these never return to zero. */
  outboxFailed: number;
  notificationsFailed: number;
}

export interface MeasureOptions {
  now?: Date;
  /** The worker's `STRIPE_EVENT_ORPHAN_TIMEOUT_MS`. */
  stripeOrphanTimeoutMs?: number;
}

/** Aggregate-only diagnostics: customer payloads must never reach monitoring. */
export async function measureProcessing(
  prisma: PrismaClient,
  options: MeasureOptions = {},
): Promise<ProcessingMetrics> {
  const now = options.now ?? new Date();
  const overdue = new Date(now.getTime() - OVERDUE_MS);
  const recent = new Date(now.getTime() - RECENT_FAILURE_MS);
  const stripeCutoff = new Date(
    now.getTime() -
      (options.stripeOrphanTimeoutMs ?? DEFAULT_STRIPE_ORPHAN_TIMEOUT_MS) -
      OVERDUE_MS,
  );
  const [
    outboxOverdue,
    outboxRecentlyFailed,
    outboxFailed,
    notificationsOverdue,
    notificationsRecentlyFailed,
    notificationsFailed,
    stripeOverdue,
  ] = await Promise.all([
    prisma.outboxEvent.count({
      where: { status: { in: ["PENDING", "PROCESSING"] }, availableAt: { lt: overdue } },
    }),
    // An outbox row has no failed-at column. `availableAt` is when its last
    // attempt was due, and the poller takes it moments later — close enough
    // for a thirty-minute window, and no migration for it.
    prisma.outboxEvent.count({ where: { status: "FAILED", availableAt: { gte: recent } } }),
    prisma.outboxEvent.count({ where: { status: "FAILED" } }),
    prisma.notification.count({
      where: { status: { in: ["PENDING", "SENDING"] }, scheduledAt: { lt: overdue } },
    }),
    prisma.notification.count({ where: { status: "FAILED", updatedAt: { gte: recent } } }),
    prisma.notification.count({ where: { status: "FAILED" } }),
    prisma.stripeEvent.count({ where: { processedAt: null, receivedAt: { lt: stripeCutoff } } }),
  ]);
  return {
    outboxOverdue,
    outboxRecentlyFailed,
    notificationsOverdue,
    notificationsRecentlyFailed,
    stripeOverdue,
    outboxFailed,
    notificationsFailed,
  };
}

/** Stuck or recently failed work is an error; old failures alone are not. */
export function processingStatus(metrics: ProcessingMetrics): ProcessingStatus {
  const alarming =
    metrics.outboxOverdue +
    metrics.outboxRecentlyFailed +
    metrics.notificationsOverdue +
    metrics.notificationsRecentlyFailed +
    metrics.stripeOverdue;
  return alarming > 0 ? "error" : "ok";
}

export interface ProcessingProbeOptions {
  timeoutMs?: number;
  stripeOrphanTimeoutMs?: number;
  measure?: (prisma: PrismaClient) => Promise<ProcessingMetrics>;
}

/**
 * Decide what the heartbeat reports. It always answers within the timeout, so
 * a hung database turns the check-in red rather than making it go missing —
 * a missing check-in alerts too, but only after the monitor's margin.
 *
 * At most one measurement runs at a time: while a previous one is still
 * outstanding, the database is evidently not answering, and starting another
 * would only queue more work behind it.
 */
export function createProcessingProbe(
  prisma: PrismaClient,
  log: Logger,
  options: ProcessingProbeOptions = {},
): () => Promise<ProcessingStatus> {
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;
  const measure =
    options.measure ??
    ((client) =>
      measureProcessing(
        client,
        options.stripeOrphanTimeoutMs === undefined
          ? {}
          : { stripeOrphanTimeoutMs: options.stripeOrphanTimeoutMs },
      ));
  let inFlight = false;

  return async () => {
    if (inFlight) {
      log.error("worker: processing health still unanswered; reporting error");
      return "error";
    }
    inFlight = true;
    const measurement = measure(prisma).finally(() => {
      inFlight = false;
    });

    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), timeoutMs);
    });
    try {
      const result = await Promise.race([measurement, timeout]);
      if (result === "timeout") {
        log.error({ timeoutMs }, "worker: processing health timed out");
        return "error";
      }
      const status = processingStatus(result);
      if (status === "error") log.warn(result, "worker: processing needs attention");
      else log.info(result, "worker: processing healthy");
      return status;
    } catch {
      log.error("worker: unable to inspect processing health");
      return "error";
    } finally {
      clearTimeout(timer);
    }
  };
}
