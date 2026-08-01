import { hasRedis, loadEnvOrExit } from "@bam/config";
import { createPrismaClient } from "@bam/db";
import { createLogger, flushSentry, initSentry } from "@bam/observability";

import type { Worker } from "bullmq";

import { closeQueues, createQueues, type QueueRegistry } from "./queues.js";
import { checkEvictionPolicy, closeRedis, getRedis, waitForReady } from "./redis.js";
import { startOutboxPoller, type OutboxPoller } from "./outbox/outbox.poller.js";
import { getEmailProvider } from "./email/email.provider.js";
import { createNotificationWorker } from "./notifications/notification.worker.js";
import { startStripePoller } from "./stripe/stripe.poller.js";

/**
 * Background worker.
 *
 * tech-impl §5.3 — hold expiration, reminders, email delivery, calendar
 * synchronisation, outbox dispatch, usage aggregation, retention cleanup.
 *
 * Epic 5, part 1 delivers the outbox dispatcher: the queues from §26 are
 * registered, and `outbox_events` rows are turned into `notifications` rows and
 * jobs. Nothing sends yet — the consumer of the `notifications` queue arrives
 * in part 2 — so the observable result of running this is that outbox rows
 * stop accumulating and notification rows appear in their place, PENDING.
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
  notifications: Worker;
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

  log.info(
    {
      queues: Object.keys(queues),
      pollIntervalMs: env.OUTBOX_POLL_INTERVAL_MS,
      emailProvider: provider.name,
    },
    "worker: queues registered, outbox dispatcher and notification sender running",
  );

  return { queues, poller, notifications };
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

        // Order matters: stop claiming work, then let the queues close, then
        // drop the connections underneath them.
        if (running !== undefined) {
          await running.poller.stop();
          // Close the consumer before the queues: it must be allowed to finish
          // the job it is holding, and a job that finishes after its queue is
          // gone cannot record its own outcome.
          await running.notifications.close();
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
