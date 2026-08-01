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
