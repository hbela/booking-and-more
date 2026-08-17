import { Queue, type JobsOptions } from "bullmq";
import type { Redis } from "ioredis";

/**
 * The queues, as named by tech-impl §26.
 *
 * Declared as one table so that adding a queue is one edit, and so the set the
 * worker registers is the set the spec lists rather than whatever accumulated.
 * Only `notifications` has a consumer in Epic 5, part 1; the rest are declared
 * because their names are part of the contract and inventing them ad hoc later
 * is how a typo becomes a silently-idle queue.
 */

export const QueueNames = {
  CALENDAR_SYNC: "calendar-sync",
  NOTIFICATIONS: "notifications",
  BOOKING_REMINDERS: "booking-reminders",
  HOLD_EXPIRATION: "hold-expiration",
  OUTBOX_DISPATCH: "outbox-dispatch",
  USAGE_AGGREGATION: "usage-aggregation",
  RETENTION_CLEANUP: "retention-cleanup",
} as const;

export type QueueName = (typeof QueueNames)[keyof typeof QueueNames];

/**
 * Retention. Without these, completed and failed jobs accumulate in Redis
 * forever — which on a 30 MB plan is not a tidiness question but an outage:
 * `noeviction` turns a full keyspace into write errors, so the queue stops
 * accepting the very jobs it exists for.
 *
 * Failures are kept longer than successes, and by count as well as age,
 * because a failed job is evidence and a completed one is not.
 */
export const DEFAULT_JOB_OPTIONS: JobsOptions = {
  removeOnComplete: { age: 24 * 60 * 60, count: 1_000 },
  removeOnFail: { age: 14 * 24 * 60 * 60, count: 5_000 },
  // Retry policy proper lives in @bam/notification-engine (tech-impl §26.3);
  // this is the ceiling that stops a permanently-broken job running forever.
  attempts: 5,
  backoff: { type: "exponential", delay: 5_000 },
};

export type QueueRegistry = Readonly<Record<QueueName, Queue>>;

/**
 * Build every queue on the shared connection.
 *
 * `connection` is passed rather than a URL precisely so BullMQ reuses it; see
 * the note in redis.ts about connection ceilings.
 */
export function createQueues(connection: Redis): QueueRegistry {
  const entries = Object.values(QueueNames).map((name) => [
    name,
    new Queue(name, { connection, defaultJobOptions: DEFAULT_JOB_OPTIONS }),
  ]);

  return Object.fromEntries(entries) as QueueRegistry;
}

export async function closeQueues(registry: QueueRegistry): Promise<void> {
  await Promise.all(Object.values(registry).map((queue) => queue.close()));
}

/** Job names on the `notifications` queue. tech-impl §26.2. */
export const NotificationJobs = {
  SEND: "send-notification",
} as const;

export interface SendNotificationJob {
  /** Always present: every repository call is tenant-scoped (rule 5). */
  tenantId: string;
  notificationId: string;
}

/**
 * Job names on the `calendar-sync` queue.
 * docs/phase-6-google-calendar-part-1.md §2.2.
 *
 * One name, not three. The row's `desiredState` and `syncedVersion` already say
 * whether this is a create, an update or a cancellation, and they say it at the
 * moment the job *runs* rather than the moment it was queued — which is the only
 * reading that survives a booking changing in between. A `create-` job that finds
 * a cancelled booking would have to ignore its own name anyway.
 */
export const CalendarJobs = {
  SYNC_EVENT: "sync-calendar-event",
} as const;

export interface SyncCalendarEventJob {
  tenantId: string;
  /** The `calendar_event_mappings` row. The job is a prompt; the row is the work. */
  eventMappingId: string;
}

/**
 * A job's identity, so the dispatcher's leg and the sweep cannot both queue the
 * same work.
 *
 * **Not the row id alone, and that is the point.** BullMQ refuses `add` for a
 * `jobId` it already holds — silently, returning the job it has — and a finished
 * job lingers under `DEFAULT_JOB_OPTIONS`: a day for a completed one, a
 * fortnight for a failed one. Keyed on the row alone, a row whose job had already
 * failed could never be enqueued again for two weeks, however many times the
 * sweep found it due. The row would sit `PENDING` forever while looking perfectly
 * healthy, which is the worst shape a bug can have.
 *
 * So the id carries what makes work genuinely *new*:
 *
 *   - `desiredVersion` — a reschedule or cancellation is a different thing to do;
 *   - `attempts` — a fresh try after a backoff is a different attempt at it.
 *
 * Both only ever move forward for a given row, so an id is never reused, and two
 * producers reaching for the same work in the same state still collapse to one
 * job. Correctness never rests on this: the processor's conditional
 * `PENDING → SYNCING` claim is what actually stops double-processing, and this
 * only saves the queue from carrying jobs that would find nothing to do.
 */
export function calendarJobId(row: {
  id: string;
  desiredVersion: number;
  attempts: number;
}): string {
  return `${row.id}:${String(row.desiredVersion)}:${String(row.attempts)}`;
}
