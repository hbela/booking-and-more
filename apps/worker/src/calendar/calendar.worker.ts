import { Worker, type Job } from "bullmq";
import type { Redis } from "ioredis";
import type { PrismaClient } from "@bam/db";
import type { GoogleCalendarClient, GoogleOAuthClient } from "@bam/google-calendar";
import type { Logger } from "@bam/observability";

import { QueueNames, type QueueRegistry, type SyncCalendarEventJob } from "../queues.js";
import { syncCalendarEvent } from "./calendar.processor.js";

/**
 * The `calendar-sync` queue's consumer. tech-impl §26.
 *
 * Concurrency is 3, lower than the notification worker's 5. Google's quota is
 * roughly 600 requests per minute **per user**, and the backfill is the one
 * workload here that arrives as a burst — a whole provider's future diary at
 * once. Three in flight drains 200 rows in well under a minute while leaving
 * plenty of headroom, and there is nothing this feature does that anybody is
 * waiting on: a calendar entry appearing four seconds later than it might have
 * is not a defect.
 */
const CONCURRENCY = 3;

/** The object form of the producers' retention; see DEFAULT_JOB_OPTIONS. */
const JOB_RETENTION = {
  completed: { age: 24 * 60 * 60, count: 1_000 },
  failed: { age: 14 * 24 * 60 * 60, count: 5_000 },
} as const;

export interface CalendarWorkerOptions {
  connection: Redis;
  prisma: PrismaClient;
  calendar: GoogleCalendarClient;
  oauth: GoogleOAuthClient;
  encryptionKey: Buffer;
  logger: Logger;
  maxAttempts: number;
  appBaseUrl: string;
  /** For the disconnection email the processor queues. See its options docblock. */
  queues: QueueRegistry;
}

export function createCalendarWorker(options: CalendarWorkerOptions): Worker {
  const worker = new Worker(
    QueueNames.CALENDAR_SYNC,
    async (job: Job<SyncCalendarEventJob>) => {
      const outcome = await syncCalendarEvent(
        { tenantId: job.data.tenantId, eventMappingId: job.data.eventMappingId },
        {
          prisma: options.prisma,
          calendar: options.calendar,
          oauth: options.oauth,
          encryptionKey: options.encryptionKey,
          logger: options.logger,
          maxAttempts: options.maxAttempts,
          appBaseUrl: options.appBaseUrl,
          queues: options.queues,
        },
      );

      return { outcome };
    },
    {
      connection: options.connection,
      concurrency: CONCURRENCY,
      removeOnComplete: JOB_RETENTION.completed,
      removeOnFail: JOB_RETENTION.failed,
    },
  );

  worker.on("failed", (job, error) => {
    // The processor has already recorded the outcome on the row and decided
    // whether it is worth another go; this is the queue's own view, and being
    // able to correlate the two is what makes a stuck row diagnosable.
    options.logger.warn(
      { jobId: job?.id, attempts: job?.attemptsMade, err: error },
      "calendar-sync: job failed",
    );
  });

  worker.on("error", (error) => {
    options.logger.error({ err: error }, "calendar-sync: worker error");
  });

  return worker;
}
