import type { PrismaClient } from "@bam/db";
import type { Logger } from "@bam/observability";

import { NotificationJobs, QueueNames, type QueueRegistry } from "../queues.js";

/**
 * Everything the queue does not have. tech-impl §26.2.
 *
 * The dispatcher hands BullMQ only what is due within
 * {@link MAX_QUEUE_LEAD_MS}; anything further out is a `notifications` row with
 * a `scheduled_at` and nothing pointing at it. This is what points at it —
 * and it is the reason a reminder booked three weeks ahead ever goes out
 * (docs/phase-5-booking-notifications.md §2.5).
 *
 * It is also the recovery path for the queue itself. A notification row is the
 * commitment; the job is only a prompt. If Redis is wiped, restarted without
 * persistence, or loses a delayed job, nothing is forgotten — the rows are still
 * PENDING, and the next sweep re-enqueues them. That property is what makes it
 * safe to run this on a Redis with no persistence at all.
 *
 * ## Why it takes no claim
 *
 * Deliberately the simplest thing that could work, because two mechanisms
 * already stop a double send and both are load-bearing elsewhere:
 *
 *   1. `jobId: notificationId` — BullMQ refuses a second job with an id it
 *      already holds, so a row enqueued twice produces one job;
 *   2. the sender claims with a conditional `PENDING → SENDING` update, so even
 *      if two jobs did exist, PostgreSQL decides which one sends and the loser
 *      sees zero rows updated.
 *
 * Adding a claim here would be a third answer to a question already settled
 * twice, and a claim this side would need its own staleness rule to survive a
 * worker dying between claiming and enqueuing.
 */

/** Matches the dispatcher's horizon: what it queues, this does not need to. */
const MAX_QUEUE_LEAD_MS = 15 * 60 * 1_000;
/** Comfortably longer than a healthy provider request. */
const STALE_CLAIM_MS = 5 * 60 * 1_000;

export interface SweeperOptions {
  prisma: PrismaClient;
  queues: QueueRegistry;
  logger: Logger;
  batchSize: number;
  maxAttempts: number;
}

export interface SweepSummary {
  found: number;
  enqueued: number;
}

/** One pass. Returns what it did so the caller can drain rather than sleep. */
export async function sweepDueNotifications(options: SweeperOptions): Promise<SweepSummary> {
  const staleBefore = new Date(Date.now() - STALE_CLAIM_MS);

  // A worker can die after PENDING → SENDING. Terminally park exhausted claims
  // first, then return the rest to PENDING so the normal enqueue path recovers
  // them. `attempts` was incremented at claim time, so a crash loop is bounded.
  await options.prisma.notification.updateMany({
    where: {
      status: "SENDING",
      OR: [{ claimedAt: null }, { claimedAt: { lt: staleBefore } }],
      attempts: { gte: options.maxAttempts },
    },
    data: {
      status: "FAILED",
      claimedAt: null,
      lastError: "notification sender claim expired after the attempt limit",
    },
  });

  await options.prisma.notification.updateMany({
    where: {
      status: "SENDING",
      OR: [{ claimedAt: null }, { claimedAt: { lt: staleBefore } }],
      attempts: { lt: options.maxAttempts },
    },
    data: {
      status: "PENDING",
      claimedAt: null,
      scheduledAt: new Date(),
      lastError: "notification sender claim expired; retrying",
    },
  });

  const due = await options.prisma.notification.findMany({
    where: {
      status: "PENDING",
      scheduledAt: { lte: new Date(Date.now() + MAX_QUEUE_LEAD_MS) },
    },
    // Oldest first, so a backlog drains in the order it was owed rather than in
    // whatever order the index happens to return.
    orderBy: { scheduledAt: "asc" },
    take: options.batchSize,
    select: { id: true, tenantId: true, scheduledAt: true },
  });

  if (due.length === 0) return { found: 0, enqueued: 0 };

  let enqueued = 0;

  for (const notification of due) {
    await options.queues[QueueNames.NOTIFICATIONS].add(
      NotificationJobs.SEND,
      { tenantId: notification.tenantId, notificationId: notification.id },
      {
        delay: Math.max(0, notification.scheduledAt.getTime() - Date.now()),
        jobId: notification.id,
      },
    );

    enqueued += 1;
  }

  return { found: due.length, enqueued };
}

export interface NotificationSweeper {
  /** Resolves once the loop has stopped and any in-flight pass has settled. */
  stop: () => Promise<void>;
}

export interface SweeperPollerOptions extends SweeperOptions {
  intervalMs: number;
}

/**
 * Drives {@link sweepDueNotifications} on an interval.
 *
 * Same shape as the outbox poller, and the same reasoning about draining: a
 * full batch means more is waiting, and sleeping an interval between batches
 * would make a backlog take (backlog / batchSize) × interval to clear.
 *
 * The one difference is that a full batch here does *not* always mean progress —
 * a row already enqueued is found again on the next pass until the sender moves
 * it out of PENDING. So the loop stops after one full batch rather than
 * spinning: the next tick will pick up whatever is left, and by then the sender
 * has had an interval to work through it.
 */
export function startNotificationSweeper(options: SweeperPollerOptions): NotificationSweeper {
  let stopped = false;
  let inFlight: Promise<void> = Promise.resolve();

  const runPass = async (): Promise<void> => {
    try {
      const summary = await sweepDueNotifications(options);

      if (summary.enqueued > 0) {
        options.logger.info({ ...summary }, "notifications: swept due rows onto the queue");
      }
    } catch (error) {
      // Most likely the database or Redis being unreachable. The rows are still
      // there; log and let the next tick try again.
      options.logger.error({ err: error }, "notifications: sweep failed");
    }
  };

  const tick = (): void => {
    if (stopped) return;
    inFlight = runPass();
  };

  const timer = setInterval(tick, options.intervalMs);

  // Run once at start-up: after a restart, anything the previous process had
  // only in Redis exists nowhere else, and waiting out an interval to discover
  // that is a minute of silence for no reason.
  tick();

  return {
    stop: async () => {
      stopped = true;
      clearInterval(timer);
      await inFlight;
    },
  };
}
