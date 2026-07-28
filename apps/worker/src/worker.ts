import { hasRedis, loadEnvOrExit } from "@bam/config";
import { createLogger, flushSentry, initSentry } from "@bam/observability";

/**
 * Background worker.
 *
 * tech-impl §5.3 — hold expiration, reminders, email delivery, calendar
 * synchronisation, outbox dispatch, usage aggregation, retention cleanup.
 *
 * None of that exists yet: all of it is queued work, and queues arrive with
 * Redis and BullMQ in Epic 5. Until then this process starts, reports that it
 * has nothing to attach to, and stays alive.
 *
 * That last part is deliberate. The alternatives are worse:
 *   - exiting looks like a crash to a supervisor and produces a restart loop;
 *   - pretending to be healthy hides the fact that no jobs are being processed.
 *
 * Idling and saying so is honest, and keeps the Epic 0 exit criterion ("all
 * applications run locally") true rather than technically-true.
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

function main(): void {
  if (!hasRedis(env)) {
    log.warn(
      { reason: "REDIS_URL not configured" },
      "worker: idle — no queues attached. Redis and BullMQ arrive in Epic 5.",
    );
  } else {
    // Epic 5 replaces this branch with the real queue registration:
    //   calendar-sync, notifications, booking-reminders, hold-expiration,
    //   outbox-dispatch, usage-aggregation, retention-cleanup (tech-impl §26).
    log.info({ queues: [] }, "worker: Redis configured but no queues are registered yet");
  }

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

  const shutdown = (signal: string) => {
    log.info({ signal }, "worker: shutting down");
    clearInterval(heartbeat);
    clearInterval(keepAlive);

    void (async () => {
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

main();
