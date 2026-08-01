import { Worker, type Job } from "bullmq";
import type { Redis } from "ioredis";
import type { PrismaClient } from "@bam/db";
import type { Logger } from "@bam/observability";

import { QueueNames, type SendNotificationJob } from "../queues.js";
import { sendNotification } from "./notification.sender.js";
import type { EmailProvider } from "../email/email.provider.js";

/**
 * The `notifications` queue's consumer. tech-impl §26.2.
 *
 * Concurrency is deliberately low. Email providers rate-limit, a burst buys
 * nothing when the work is one HTTP call per job, and a `noeviction` Redis
 * under a stampede is the failure mode this whole design has been avoiding.
 */
const CONCURRENCY = 5;

/** The object form of the producers' retention; see DEFAULT_JOB_OPTIONS. */
const JOB_RETENTION = {
  completed: { age: 24 * 60 * 60, count: 1_000 },
  failed: { age: 14 * 24 * 60 * 60, count: 5_000 },
} as const;

export interface NotificationWorkerOptions {
  connection: Redis;
  prisma: PrismaClient;
  provider: EmailProvider;
  logger: Logger;
  maxAttempts: number;
}

export function createNotificationWorker(options: NotificationWorkerOptions): Worker {
  const worker = new Worker(
    QueueNames.NOTIFICATIONS,
    async (job: Job<SendNotificationJob>) => {
      const outcome = await sendNotification(
        { tenantId: job.data.tenantId, notificationId: job.data.notificationId },
        {
          prisma: options.prisma,
          provider: options.provider,
          logger: options.logger,
          maxAttempts: options.maxAttempts,
        },
      );

      return { outcome };
    },
    {
      connection: options.connection,
      concurrency: CONCURRENCY,
      // Same retention as the producers, so a job's history does not outlive
      // the queue's memory budget. Narrowed because JobsOptions allows a number
      // or boolean here and the Worker only accepts the object form.
      removeOnComplete: JOB_RETENTION.completed,
      removeOnFail: JOB_RETENTION.failed,
    },
  );

  worker.on("failed", (job, error) => {
    // The sender has already recorded the outcome on the row; this is the
    // queue's own view of it, and the two are worth being able to correlate.
    options.logger.warn(
      { jobId: job?.id, attempts: job?.attemptsMade, err: error },
      "notifications: job failed",
    );
  });

  worker.on("error", (error) => {
    options.logger.error({ err: error }, "notifications: worker error");
  });

  return worker;
}
