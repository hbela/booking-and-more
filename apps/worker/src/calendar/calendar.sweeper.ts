import type { PrismaClient } from "@bam/db";
import type { Logger } from "@bam/observability";

import { CalendarJobs, QueueNames, calendarJobId, type QueueRegistry } from "../queues.js";

/**
 * Everything the `calendar-sync` queue does not have.
 * docs/phase-6-google-calendar-part-1.md §2.2.
 *
 * The same shape as `notification.sweeper.ts`, including its reasoning about
 * draining, and here for the same three reasons:
 *
 *   1. **The backfill.** `POST /calendars/select` queues up to
 *      `CALENDAR_BACKFILL_LIMIT` rows and enqueues nothing — the API owns no
 *      queue. Without this, connecting a calendar would fill a table and never a
 *      diary.
 *   2. **Backoff.** A row released with a `nextAttemptAt` an hour out has no job
 *      pointing at it; this is what looks again when the hour is up.
 *   3. **Redis.** A row is the commitment and a job is only a prompt. If Redis is
 *      wiped or restarted without persistence, nothing is forgotten.
 *
 * ## Two passes, and what each is for
 *
 * The first reclaims rows a dead worker left `SYNCING`. The second enqueues what
 * is due. In that order, so a reclaimed row goes back out in the same pass rather
 * than waiting another interval.
 *
 * ## What is deliberately never swept
 *
 * **`FAILED` rows.** tech-impl §26.3 forbids retrying a permanently-broken thing,
 * and the whole point of parking one is that a human, a reconnect, or
 * `POST /sync` decides it is worth another go. A sweep that picked them up would
 * make `FAILED` mean "slow" instead of "stuck".
 *
 * **Rows behind an integration that is not `ACTIVE`.** The processor would only
 * release them again, so enqueueing would be a minute-by-minute churn of jobs
 * that cannot work. When the provider reconnects, the integration goes back to
 * `ACTIVE` and the next pass finds them — which is what "a reconnect resumes"
 * means in practice.
 */

export interface CalendarSweeperOptions {
  prisma: PrismaClient;
  queues: QueueRegistry;
  logger: Logger;
  batchSize: number;
  /** How long a `SYNCING` row may sit before another worker may take it back. */
  staleClaimSeconds: number;
}

export interface CalendarSweepSummary {
  reclaimed: number;
  found: number;
  enqueued: number;
}

export async function sweepCalendarEvents(
  options: CalendarSweeperOptions,
): Promise<CalendarSweepSummary> {
  const reclaimed = await reclaimStaleClaims(options);

  const due = await options.prisma.calendarEventMapping.findMany({
    where: {
      syncStatus: "PENDING",
      nextAttemptAt: { lte: new Date() },
      calendarMapping: {
        active: true,
        writeBookings: true,
        integration: { status: "ACTIVE" },
      },
    },
    // Oldest first, so a backlog drains in the order it was owed. For the
    // backfill that also means the soonest appointments reach the diary first,
    // which is the same ordering the backfill itself chose and for the same
    // reason.
    orderBy: { nextAttemptAt: "asc" },
    take: options.batchSize,
    select: { id: true, tenantId: true, desiredVersion: true, attempts: true },
  });

  let enqueued = 0;

  for (const row of due) {
    await options.queues[QueueNames.CALENDAR_SYNC].add(
      CalendarJobs.SYNC_EVENT,
      { tenantId: row.tenantId, eventMappingId: row.id },
      { jobId: calendarJobId(row) },
    );

    enqueued += 1;
  }

  return { reclaimed, found: due.length, enqueued };
}

/**
 * Take back rows a worker claimed and never finished.
 *
 * The same hole `outbox_events.claimed_at` closes: a process killed between the
 * claim and the outcome leaves a row `SYNCING` with nothing working on it, and
 * nothing else would ever look at it again.
 *
 * `attempts` is **not** reset. The claim already counted the try, and a worker
 * that dies mid-call may well have died *because* of the call — a reclaim that
 * cleared the counter would let a poisonous row cycle forever.
 */
async function reclaimStaleClaims(options: CalendarSweeperOptions): Promise<number> {
  const cutoff = new Date(Date.now() - options.staleClaimSeconds * 1_000);

  const { count } = await options.prisma.calendarEventMapping.updateMany({
    where: { syncStatus: "SYNCING", claimedAt: { lt: cutoff } },
    data: { syncStatus: "PENDING", claimedAt: null, nextAttemptAt: new Date() },
  });

  if (count > 0) {
    options.logger.warn({ count }, "calendar: reclaimed rows left syncing by a dead worker");
  }

  return count;
}

export interface CalendarSweeper {
  /** Resolves once the loop has stopped and any in-flight pass has settled. */
  stop: () => Promise<void>;
}

export interface CalendarSweeperPollerOptions extends CalendarSweeperOptions {
  intervalMs: number;
}

/**
 * Drives {@link sweepCalendarEvents} on an interval.
 *
 * Stops after one full batch rather than spinning, exactly as the notification
 * sweeper does: a row already enqueued is found again on the next pass until the
 * processor moves it out of `PENDING`, so "a full batch" does not reliably mean
 * "more progress is available".
 */
export function startCalendarSweeper(options: CalendarSweeperPollerOptions): CalendarSweeper {
  let stopped = false;
  let inFlight: Promise<void> = Promise.resolve();

  const runPass = async (): Promise<void> => {
    try {
      const summary = await sweepCalendarEvents(options);

      if (summary.enqueued > 0) {
        options.logger.info({ ...summary }, "calendar: swept due rows onto the queue");
      }
    } catch (error) {
      // Most likely the database or Redis being unreachable. The rows are still
      // there; log and let the next tick try again.
      options.logger.error({ err: error }, "calendar: sweep failed");
    }
  };

  const tick = (): void => {
    if (stopped) return;
    inFlight = runPass();
  };

  const timer = setInterval(tick, options.intervalMs);

  // Once at start-up: after a restart, anything the previous process held only
  // in Redis exists nowhere else, and a provider who connected a calendar a
  // moment before the deploy should not wait out an interval to see it fill.
  tick();

  return {
    stop: async () => {
      stopped = true;
      clearInterval(timer);
      await inFlight;
    },
  };
}
