import { hasRedis, loadEnvOrExit } from "@bam/config";
import { createPrismaClient } from "@bam/db";
import { createLogger, flushSentry, initSentry } from "@bam/observability";
// PARKED — Epic 6 part 1 (see the block in `attachQueues` below).
// import { hasGoogleCalendar } from "@bam/config";
// import { parseEncryptionKey } from "@bam/crypto";
// import { createGoogleCalendarClient, createGoogleOAuthClient } from "@bam/google-calendar";

import type { Worker } from "bullmq";

import { closeQueues, createQueues, type QueueRegistry } from "./queues.js";
import { checkEvictionPolicy, closeRedis, getRedis, waitForReady } from "./redis.js";
import { startOutboxPoller, type OutboxPoller } from "./outbox/outbox.poller.js";
import { getEmailProvider } from "./email/email.provider.js";
import { createNotificationWorker } from "./notifications/notification.worker.js";
import {
  startNotificationSweeper,
  type NotificationSweeper,
} from "./notifications/notification.sweeper.js";
import { startStripePoller } from "./stripe/stripe.poller.js";
// PARKED — Epic 6 part 1.
// import { createCalendarWorker } from "./calendar/calendar.worker.js";
// import { startCalendarSweeper, type CalendarSweeper } from "./calendar/calendar.sweeper.js";

/**
 * Background worker.
 *
 * tech-impl §5.3 — hold expiration, reminders, email delivery, calendar
 * synchronisation, outbox dispatch, usage aggregation, retention cleanup.
 *
 * Three things run here, and they are deliberately separate. The **outbox
 * poller** turns `outbox_events` into `notifications` rows and jobs. The
 * **notification worker** consumes those jobs and sends. The **sweep** picks up
 * rows the queue never had — reminders past the dispatcher's 15-minute horizon,
 * and anything a Redis restart lost (docs/phase-5-booking-notifications.md
 * §2.5). Only the first two existed before booking reminders needed sending.
 *
 * Without REDIS_URL the process still starts, reports that it has nothing to
 * attach to, and stays alive. That remains deliberate; the alternatives are
 * worse:
 *   - exiting looks like a crash to a supervisor and produces a restart loop;
 *   - pretending to be healthy hides the fact that no jobs are being processed.
 */

const env = loadEnvOrExit();

initSentry({
  dsn: env.SENTRY_DSN,
  environment: env.NODE_ENV,
  service: "worker",
});

const log = createLogger({
  service: "worker",
  level: env.LOG_LEVEL,
  pretty: env.NODE_ENV !== "production",
});

/** Report liveness on this cadence so a silent process is distinguishable from a dead one. */
const HEARTBEAT_MS = 60_000;

interface RunningQueues {
  queues: QueueRegistry;
  poller: OutboxPoller;
  sweeper: NotificationSweeper;
  notifications: Worker;
  // PARKED — Epic 6 part 1. Was: both absent unless the four `GOOGLE_*`
  // variables are set. Nothing now writes calendar rows either (the
  // dispatcher's leg is parked too), so there is nothing left to drain.
  //
  // calendar?: { worker: Worker; sweeper: CalendarSweeper };
}

async function attachQueues(prisma: ReturnType<typeof createPrismaClient>): Promise<RunningQueues> {
  const redis = getRedis({ url: env.REDIS_URL!, logger: log });

  // The check has to wait for the socket, or it races the connection and
  // reports "unavailable" every time — a check that never runs while looking
  // like one that did.
  if (await waitForReady(redis)) {
    // Advisory, not fatal: a misconfigured eviction policy is worth shouting
    // about, but refusing to start would leave the outbox undrained.
    await checkEvictionPolicy(redis, log);
  } else {
    log.warn("redis: not ready in time; skipping the eviction-policy check");
  }

  const queues = createQueues(redis);

  const poller = startOutboxPoller({
    prisma,
    queues,
    logger: log,
    intervalMs: env.OUTBOX_POLL_INTERVAL_MS,
    batchSize: env.OUTBOX_BATCH_SIZE,
    maxAttempts: env.OUTBOX_MAX_ATTEMPTS,
    reminderLeadHours: env.BOOKING_REMINDER_LEAD_HOURS,
    appBaseUrl: env.APP_BASE_URL,
  });

  // Constructed lazily and degrading to a logger when unconfigured (rule 4):
  // no API key means messages are written to the log, not that the worker dies.
  const provider = getEmailProvider({
    apiKey: env.RESEND_API_KEY,
    from: env.EMAIL_FROM,
    logger: log,
  });

  const notifications = createNotificationWorker({
    connection: redis,
    prisma,
    provider,
    logger: log,
    maxAttempts: env.OUTBOX_MAX_ATTEMPTS,
  });

  // The catch-up path for everything the dispatcher did not queue: reminders
  // past its 15-minute horizon, and anything a Redis restart lost. Without it a
  // reminder is a row nothing ever looks at again.
  const sweeper = startNotificationSweeper({
    prisma,
    queues,
    logger: log,
    batchSize: env.OUTBOX_BATCH_SIZE,
    intervalMs: env.NOTIFICATION_SWEEP_INTERVAL_MS,
  });

  // --- Epic 6, part 1 — PARKED 2026-08-17 ------------------------------------
  // Deferred for delivery time. The processor, sweeper and their tests under
  // `./calendar/` are complete and still compile; they are simply never
  // constructed, so the `calendar-sync` queue has no consumer — the state it
  // was in before this epic. Un-parking is this block, the two import lines,
  // the `calendar?` field on `RunningQueues`, the two `running.calendar?.`
  // shutdown calls, and the leg in `outbox.dispatcher.ts`.
  //
  // const calendar = hasGoogleCalendar(env)
  //   ? {
  //       worker: createCalendarWorker({
  //         connection: redis,
  //         prisma,
  //         calendar: createGoogleCalendarClient(),
  //         oauth: createGoogleOAuthClient({
  //           clientId: env.GOOGLE_CLIENT_ID!,
  //           clientSecret: env.GOOGLE_CLIENT_SECRET!,
  //           redirectUri: env.GOOGLE_REDIRECT_URI!,
  //         }),
  //         // Parsed here, at boot, so a malformed key fails the deployment rather
  //         // than one provider's first sync.
  //         encryptionKey: parseEncryptionKey(env.GOOGLE_TOKEN_ENCRYPTION_KEY!),
  //         logger: log,
  //         maxAttempts: env.CALENDAR_MAX_ATTEMPTS,
  //         appBaseUrl: env.APP_BASE_URL,
  //         // The processor queues the disconnection email itself: it originates
  //         // in the worker, so there is no outbox event to plan it from.
  //         queues,
  //       }),
  //       // The drain for the backfill, the timer behind every backoff, and the
  //       // recovery path if Redis loses a job. Without it, connecting a calendar
  //       // fills a table and never a diary.
  //       sweeper: startCalendarSweeper({
  //         prisma,
  //         queues,
  //         logger: log,
  //         batchSize: env.CALENDAR_SWEEP_BATCH_SIZE,
  //         intervalMs: env.CALENDAR_SWEEP_INTERVAL_MS,
  //         // Comfortably longer than a healthy Google call, so a slow worker is
  //         // not mistaken for a dead one.
  //         staleClaimSeconds: 300,
  //       }),
  //     }
  //   : undefined;

  log.info(
    {
      queues: Object.keys(queues),
      pollIntervalMs: env.OUTBOX_POLL_INTERVAL_MS,
      sweepIntervalMs: env.NOTIFICATION_SWEEP_INTERVAL_MS,
      emailProvider: provider.name,
      calendarSync: false,
    },
    "worker: queues registered, outbox dispatcher, sweep and notification sender running",
  );

  // Unconditional while parked, and deliberately not silent: a deployment that
  // has set the `GOOGLE_*` variables would otherwise see no consumer and no
  // explanation. The old message said rows would accumulate PENDING; none are
  // written now, which is the more useful thing for an operator to know.
  log.info(
    { reason: "Epic 6 part 1 parked (docs/phase-6-google-calendar-part-1.md)" },
    "worker: calendar sync is off — no calendar rows are written and none are drained",
  );

  return { queues, poller, sweeper, notifications };
}

async function main(): Promise<void> {
  const prisma = createPrismaClient({ databaseUrl: env.DATABASE_URL });

  let running: RunningQueues | undefined;

  if (hasRedis(env)) {
    running = await attachQueues(prisma);
  } else {
    log.warn(
      { reason: "REDIS_URL not configured" },
      "worker: idle — no queues attached. Outbox events will accumulate until Redis is configured.",
    );
  }

  // Started regardless of Redis: it reads and writes PostgreSQL only. That is
  // worth keeping — it means a customer who pays while Redis is down is still
  // activated, and only their confirmation email waits
  // (docs/phase-9-subscription-and-activation.md §3.3).
  const stripeEvents = startStripePoller({
    prisma,
    logger: log,
    intervalMs: env.OUTBOX_POLL_INTERVAL_MS,
    batchSize: env.OUTBOX_BATCH_SIZE,
    // How a plan is identified, now that a scheduled downgrade carries a bare
    // price ID and no metadata (phase-9-subscription-lifecycle.md §2.4). Config
    // validation requires both whenever Stripe is configured at all.
    planPrices: {
      ...(env.STRIPE_PRICE_STARTER === undefined ? {} : { STARTER: env.STRIPE_PRICE_STARTER }),
      ...(env.STRIPE_PRICE_PROFESSIONAL === undefined
        ? {}
        : { PROFESSIONAL: env.STRIPE_PRICE_PROFESSIONAL }),
    },
    orphanTimeoutMs: env.STRIPE_EVENT_ORPHAN_TIMEOUT_MS,
  });

  const heartbeat = setInterval(() => {
    log.debug({ uptimeSeconds: Math.round(process.uptime()) }, "worker: heartbeat");
  }, HEARTBEAT_MS);

  // Do not hold the event loop open on the timer alone — but do keep the
  // process alive, which the timer being unref'd would otherwise prevent.
  heartbeat.unref();

  // Explicit keep-alive so the intent is visible rather than an accident of
  // which handles happen to be open.
  const keepAlive = setInterval(() => {
    /* intentionally empty */
  }, 1 << 30);

  let shuttingDown = false;

  const shutdown = (signal: string): void => {
    // A second SIGTERM during a drain must not start a second drain.
    if (shuttingDown) return;
    shuttingDown = true;

    log.info({ signal }, "worker: shutting down");
    clearInterval(heartbeat);
    clearInterval(keepAlive);

    void (async () => {
      try {
        await stripeEvents.stop();

        // Order matters, in three stages: stop everything that *produces* work,
        // then let the consumers finish what they hold, then drop the queues and
        // the connection underneath them.
        //
        // Producers first is the load-bearing part. A sweeper still running while
        // its consumer closes would enqueue jobs nothing is left to take — they
        // would survive in Redis, so nothing is lost, but the shutdown log would
        // claim a clean drain that did not happen.
        if (running !== undefined) {
          await running.poller.stop();
          await running.sweeper.stop();
          // PARKED — Epic 6 part 1.
          // await running.calendar?.sweeper.stop();

          // Consumers before the queues: each must be allowed to finish the job
          // it is holding, and a job that finishes after its queue is gone
          // cannot record its own outcome. The calendar processor in particular
          // may be mid-write to Google — its row is durable and its write is
          // idempotent, so being cut off is survivable, but it is still the
          // difference between one Google call and two.
          await running.notifications.close();
          // PARKED — Epic 6 part 1.
          // await running.calendar?.worker.close();
          await closeQueues(running.queues);
        }
        await closeRedis();
        await prisma.$disconnect();
      } catch (error) {
        log.error({ err: error }, "worker: shutdown did not complete cleanly");
      }

      await flushSentry();
      process.exit(0);
    })();
  };

  process.on("SIGTERM", () => {
    shutdown("SIGTERM");
  });
  process.on("SIGINT", () => {
    shutdown("SIGINT");
  });

  log.info({ nodeEnv: env.NODE_ENV }, "worker: started");
}

void main().catch((error: unknown) => {
  log.error({ err: error }, "worker: failed to start");
  process.exit(1);
});
