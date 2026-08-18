import type { PrismaClient } from "@bam/db";
import type { Logger } from "@bam/observability";

const CLEANUP_INTERVAL_MS = 60 * 60 * 1_000;
const DEFAULT_BATCH_SIZE = 500;
const DAY_MS = 24 * 60 * 60 * 1_000;

export const RETENTION_DAYS = {
  auditLogs: 365,
  bookingManagementTokens: 30,
  completedOutbox: 30,
  notificationPayloads: 30,
  processedStripePayloads: 30,
  staleHolds: 1,
} as const;

export type RetentionPolicy =
  | "expiredSessions"
  | "expiredIdempotencyKeys"
  | "staleBookingHolds"
  | "expiredCalendarOauthStates"
  | "completedOutboxEvents"
  | "terminalNotificationPayloads"
  | "processedStripePayloads"
  | "expiredBookingManagementTokens"
  | "oldAuditLogs";

export type RetentionCounts = Record<RetentionPolicy, number>;

interface CountRow {
  policy: RetentionPolicy;
  affected: bigint;
}

interface BacklogRow {
  oldest_eligible_at: Date | null;
}

export interface RetentionSummary {
  counts: RetentionCounts;
  durationMs: number;
  oldestRemainingEligibleAt: Date | null;
}

export interface RetentionCleanup {
  stop: () => Promise<void>;
}

function cutoff(now: Date, days: number): Date {
  return new Date(now.getTime() - days * DAY_MS);
}

/**
 * Apply every policy in one bounded PostgreSQL statement. Each CTE has its own
 * LIMIT, so an old installation catches up without one cleanup monopolising
 * the database. The advisory lock makes multiple worker replicas harmless.
 * Operational evidence stays as metadata where possible; replayable payloads
 * and bearer-token hashes are scrubbed rather than retaining secrets forever.
 */
export async function runRetentionBatch(
  prisma: PrismaClient,
  options: { now?: Date; batchSize?: number } = {},
): Promise<RetentionSummary> {
  const startedAt = performance.now();
  const now = options.now ?? new Date();
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const holdCutoff = cutoff(now, RETENTION_DAYS.staleHolds);
  const payloadCutoff = cutoff(now, RETENTION_DAYS.notificationPayloads);
  const outboxCutoff = cutoff(now, RETENTION_DAYS.completedOutbox);
  const stripeCutoff = cutoff(now, RETENTION_DAYS.processedStripePayloads);
  const managementCutoff = cutoff(now, RETENTION_DAYS.bookingManagementTokens);
  const auditCutoff = cutoff(now, RETENTION_DAYS.auditLogs);

  const rows = await prisma.$queryRaw<CountRow[]>`
    WITH cleanup_lock AS (
      SELECT pg_try_advisory_xact_lock(726267381) AS acquired
    ),
    expired_sessions AS (
      DELETE FROM "sessions"
      WHERE "id" IN (
        SELECT "id" FROM "sessions"
        WHERE "expiresAt" <= ${now}
          AND (SELECT acquired FROM cleanup_lock)
        ORDER BY "expiresAt" ASC
        LIMIT ${batchSize}
      )
      RETURNING 1
    ),
    expired_idempotency AS (
      DELETE FROM "idempotency_keys"
      WHERE "id" IN (
        SELECT "id" FROM "idempotency_keys"
        WHERE "expires_at" <= ${now}
          AND (SELECT acquired FROM cleanup_lock)
        ORDER BY "expires_at" ASC
        LIMIT ${batchSize}
      )
      RETURNING 1
    ),
    stale_holds AS (
      DELETE FROM "booking_holds"
      WHERE "id" IN (
        SELECT "id" FROM "booking_holds"
        WHERE "expires_at" <= ${holdCutoff}
          AND (SELECT acquired FROM cleanup_lock)
        ORDER BY "expires_at" ASC
        LIMIT ${batchSize}
      )
      RETURNING 1
    ),
    expired_oauth_states AS (
      DELETE FROM "calendar_oauth_states"
      WHERE "id" IN (
        SELECT "id" FROM "calendar_oauth_states"
        WHERE "expires_at" <= ${now}
          AND (SELECT acquired FROM cleanup_lock)
        ORDER BY "expires_at" ASC
        LIMIT ${batchSize}
      )
      RETURNING 1
    ),
    completed_outbox AS (
      DELETE FROM "outbox_events"
      WHERE "id" IN (
        SELECT "id" FROM "outbox_events"
        WHERE "status" = 'PROCESSED'
          AND "processed_at" <= ${outboxCutoff}
          AND (SELECT acquired FROM cleanup_lock)
        ORDER BY "processed_at" ASC
        LIMIT ${batchSize}
      )
      RETURNING 1
    ),
    terminal_notifications AS (
      UPDATE "notifications"
      SET "payload_json" = NULL, "last_error" = NULL
      WHERE "id" IN (
        SELECT "id" FROM "notifications"
        WHERE "status" IN ('FAILED', 'SKIPPED')
          AND "updated_at" <= ${payloadCutoff}
          AND ("payload_json" IS NOT NULL OR "last_error" IS NOT NULL)
          AND (SELECT acquired FROM cleanup_lock)
        ORDER BY "updated_at" ASC
        LIMIT ${batchSize}
      )
      RETURNING 1
    ),
    processed_stripe AS (
      UPDATE "stripe_events"
      SET "payload_json" = '{}'::jsonb, "last_error" = NULL
      WHERE "id" IN (
        SELECT "id" FROM "stripe_events"
        WHERE "processed_at" <= ${stripeCutoff}
          AND ("payload_json" <> '{}'::jsonb OR "last_error" IS NOT NULL)
          AND (SELECT acquired FROM cleanup_lock)
        ORDER BY "processed_at" ASC
        LIMIT ${batchSize}
      )
      RETURNING 1
    ),
    expired_management_tokens AS (
      UPDATE "bookings"
      SET "management_token_hash" = NULL
      WHERE "id" IN (
        SELECT "id" FROM "bookings"
        WHERE "management_token_hash" IS NOT NULL
          AND COALESCE("cancelled_at", "end_at") <= ${managementCutoff}
          AND (SELECT acquired FROM cleanup_lock)
        ORDER BY COALESCE("cancelled_at", "end_at") ASC
        LIMIT ${batchSize}
      )
      RETURNING 1
    ),
    old_audit_logs AS (
      DELETE FROM "audit_logs"
      WHERE "id" IN (
        SELECT "id" FROM "audit_logs"
        WHERE "created_at" <= ${auditCutoff}
          AND (SELECT acquired FROM cleanup_lock)
        ORDER BY "created_at" ASC
        LIMIT ${batchSize}
      )
      RETURNING 1
    )
    SELECT 'expiredSessions' AS policy, COUNT(*) AS affected FROM expired_sessions
    UNION ALL SELECT 'expiredIdempotencyKeys', COUNT(*) FROM expired_idempotency
    UNION ALL SELECT 'staleBookingHolds', COUNT(*) FROM stale_holds
    UNION ALL SELECT 'expiredCalendarOauthStates', COUNT(*) FROM expired_oauth_states
    UNION ALL SELECT 'completedOutboxEvents', COUNT(*) FROM completed_outbox
    UNION ALL SELECT 'terminalNotificationPayloads', COUNT(*) FROM terminal_notifications
    UNION ALL SELECT 'processedStripePayloads', COUNT(*) FROM processed_stripe
    UNION ALL SELECT 'expiredBookingManagementTokens', COUNT(*) FROM expired_management_tokens
    UNION ALL SELECT 'oldAuditLogs', COUNT(*) FROM old_audit_logs
  `;

  const [backlog] = await prisma.$queryRaw<BacklogRow[]>`
    SELECT MIN(eligible_at) AS oldest_eligible_at
    FROM (
      SELECT MIN("expiresAt") AS eligible_at FROM "sessions" WHERE "expiresAt" <= ${now}
      UNION ALL SELECT MIN("expires_at") FROM "idempotency_keys" WHERE "expires_at" <= ${now}
      UNION ALL SELECT MIN("expires_at") FROM "booking_holds" WHERE "expires_at" <= ${holdCutoff}
      UNION ALL SELECT MIN("expires_at") FROM "calendar_oauth_states" WHERE "expires_at" <= ${now}
      UNION ALL SELECT MIN("processed_at") FROM "outbox_events" WHERE "status" = 'PROCESSED' AND "processed_at" <= ${outboxCutoff}
      UNION ALL SELECT MIN("updated_at") FROM "notifications" WHERE "status" IN ('FAILED', 'SKIPPED') AND "updated_at" <= ${payloadCutoff} AND ("payload_json" IS NOT NULL OR "last_error" IS NOT NULL)
      UNION ALL SELECT MIN("processed_at") FROM "stripe_events" WHERE "processed_at" <= ${stripeCutoff} AND ("payload_json" <> '{}'::jsonb OR "last_error" IS NOT NULL)
      UNION ALL SELECT MIN(COALESCE("cancelled_at", "end_at")) FROM "bookings" WHERE "management_token_hash" IS NOT NULL AND COALESCE("cancelled_at", "end_at") <= ${managementCutoff}
      UNION ALL SELECT MIN("created_at") FROM "audit_logs" WHERE "created_at" <= ${auditCutoff}
    ) eligible
  `;

  const counts = Object.fromEntries(
    rows.map((row) => [row.policy, Number(row.affected)]),
  ) as RetentionCounts;

  return {
    counts,
    durationMs: Math.round(performance.now() - startedAt),
    oldestRemainingEligibleAt: backlog?.oldest_eligible_at ?? null,
  };
}

export function startRetentionCleanup(options: {
  prisma: PrismaClient;
  logger: Logger;
  intervalMs?: number;
  batchSize?: number;
}): RetentionCleanup {
  let stopped = false;
  let running = false;
  let consecutiveFailures = 0;
  let inFlight: Promise<void> = Promise.resolve();

  const tick = (): void => {
    if (stopped || running) return;
    running = true;
    inFlight = runRetentionBatch(options.prisma, {
      ...(options.batchSize === undefined ? {} : { batchSize: options.batchSize }),
    })
      .then((summary) => {
        consecutiveFailures = 0;
        options.logger.info(
          {
            ...summary,
            oldestRemainingEligibleAt: summary.oldestRemainingEligibleAt?.toISOString() ?? null,
          },
          "retention: cleanup batch completed",
        );
      })
      .catch((error: unknown) => {
        consecutiveFailures += 1;
        options.logger[consecutiveFailures >= 3 ? "fatal" : "error"](
          { err: error, consecutiveFailures },
          "retention: cleanup batch failed",
        );
      })
      .finally(() => {
        running = false;
      });
  };

  const timer = setInterval(tick, options.intervalMs ?? CLEANUP_INTERVAL_MS);
  tick();

  return {
    stop: async () => {
      stopped = true;
      clearInterval(timer);
      await inFlight;
    },
  };
}
