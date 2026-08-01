import { Prisma, type PrismaClient } from "@bam/db";

/**
 * The outbox, as SQL. tech-impl §12.
 *
 * Raw rather than Prisma's query builder because the claim has to be one
 * statement: `SELECT … FOR UPDATE SKIP LOCKED` inside an `UPDATE`. Prisma
 * cannot express row-level locking, and the two-statement version it can
 * express — read the pending rows, then mark them — has a window between the
 * read and the write in which a second worker reads the same rows. That is the
 * same shape of mistake as checking capacity before inserting a reservation
 * (CLAUDE.md rule 14), and it has the same fix: let PostgreSQL arbitrate.
 */

/** A claimed row, ready to dispatch. */
export interface ClaimedOutboxEvent {
  id: string;
  tenantId: string;
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  payload: unknown;
  /** Including the claim that just happened. */
  attempts: number;
}

interface ClaimedRow {
  id: string;
  tenant_id: string;
  event_type: string;
  aggregate_type: string;
  aggregate_id: string;
  payload_json: unknown;
  attempts: number;
}

export interface ClaimOptions {
  batchSize: number;
  /**
   * How long a row may sit in PROCESSING before another worker may take it.
   *
   * This is a bet: too short and two workers dispatch the same event while the
   * first is merely slow; too long and a crashed worker's events wait. Both are
   * survivable — the notification dedupe key makes a double dispatch harmless
   * (that is the whole point of it) — so the value is chosen to be comfortably
   * longer than a healthy batch rather than tuned finely.
   */
  staleClaimSeconds: number;
}

/**
 * Take up to `batchSize` events, marking them PROCESSING in the same statement.
 *
 * `attempts` is incremented at claim time, not at failure time. A worker killed
 * mid-dispatch would otherwise be reclaimed with its attempt count unchanged
 * and retry forever; counting the claim means even a crash loop terminates at
 * the attempt ceiling and parks the row for a human.
 */
export async function claimOutboxEvents(
  prisma: PrismaClient,
  options: ClaimOptions,
): Promise<ClaimedOutboxEvent[]> {
  const rows = await prisma.$queryRaw<ClaimedRow[]>(Prisma.sql`
    UPDATE outbox_events AS e
    SET status = 'PROCESSING',
        claimed_at = now(),
        attempts = e.attempts + 1
    FROM (
      SELECT id
      FROM outbox_events
      WHERE (status = 'PENDING' AND available_at <= now())
         OR (status = 'PROCESSING'
             AND claimed_at < now() - make_interval(secs => ${options.staleClaimSeconds}))
      ORDER BY available_at ASC
      FOR UPDATE SKIP LOCKED
      LIMIT ${options.batchSize}
    ) AS claimed
    WHERE e.id = claimed.id
    RETURNING e.id,
              e.tenant_id,
              e.event_type,
              e.aggregate_type,
              e.aggregate_id,
              e.payload_json,
              e.attempts
  `);

  return rows.map((row) => ({
    id: row.id,
    tenantId: row.tenant_id,
    eventType: row.event_type,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    payload: row.payload_json,
    attempts: row.attempts,
  }));
}

/**
 * Done. The row stays as the record that it happened — with its payload cleared.
 *
 * Clearing is not tidiness. Some payloads carry a secret that exists nowhere
 * else for exactly as long as it takes to dispatch: a provisioning event holds
 * the raw invitation token, because the invitation itself stores only a hash
 * and the worker could not otherwise build the link. Emptying the payload on
 * success bounds that exposure to the seconds between commit and dispatch.
 *
 * Nothing diagnostic is lost. Every event type's payload restates ids that are
 * already in `aggregateType`/`aggregateId`, which is why the payload was only
 * ever a convenience.
 */
export async function markProcessed(
  prisma: PrismaClient,
  args: { tenantId: string; eventId: string },
): Promise<void> {
  await prisma.outboxEvent.updateMany({
    where: { id: args.eventId, tenantId: args.tenantId },
    data: {
      status: "PROCESSED",
      processedAt: new Date(),
      claimedAt: null,
      lastError: null,
      payload: {},
    },
  });
}

/** Back to the pool, invisible until `availableAt`. */
export async function markForRetry(
  prisma: PrismaClient,
  args: { tenantId: string; eventId: string; delayMs: number; error: string },
): Promise<void> {
  await prisma.outboxEvent.updateMany({
    where: { id: args.eventId, tenantId: args.tenantId },
    data: {
      status: "PENDING",
      availableAt: new Date(Date.now() + args.delayMs),
      claimedAt: null,
      lastError: truncateError(args.error),
    },
  });
}

/**
 * Parked for a human.
 *
 * Never deleted: an event that could not be dispatched is the only evidence
 * that someone is owed a message, and throwing it away turns a visible failure
 * into a silent one.
 */
export async function markFailed(
  prisma: PrismaClient,
  args: { tenantId: string; eventId: string; error: string },
): Promise<void> {
  await prisma.outboxEvent.updateMany({
    where: { id: args.eventId, tenantId: args.tenantId },
    data: { status: "FAILED", claimedAt: null, lastError: truncateError(args.error) },
  });
}

/** Provider errors can carry a whole HTML page; the column is for diagnosis. */
function truncateError(error: string): string {
  const LIMIT = 1_000;
  return error.length <= LIMIT ? error : `${error.slice(0, LIMIT)}…`;
}
