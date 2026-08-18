import type { PrismaClient } from "@bam/db";
import type { Logger } from "@bam/observability";

const CLEANUP_INTERVAL_MS = 60 * 60 * 1_000;

export interface IdempotencyCleanup {
  stop: () => Promise<void>;
}

export async function deleteExpiredIdempotencyKeys(
  prisma: PrismaClient,
  now = new Date(),
): Promise<number> {
  const result = await prisma.idempotencyKey.deleteMany({ where: { expiresAt: { lte: now } } });
  return result.count;
}

/** Hourly cleanup bounds retention of replay bodies, including bearer tokens. */
export function startIdempotencyCleanup(options: {
  prisma: PrismaClient;
  logger: Logger;
}): IdempotencyCleanup {
  let stopped = false;
  let running = false;
  let inFlight: Promise<void> = Promise.resolve();

  const tick = (): void => {
    if (stopped || running) return;
    running = true;
    inFlight = deleteExpiredIdempotencyKeys(options.prisma)
      .then((deleted) => {
        if (deleted > 0) {
          options.logger.info({ deleted }, "retention: expired idempotency keys deleted");
        }
      })
      .catch((error: unknown) => {
        options.logger.error({ err: error }, "retention: idempotency cleanup failed");
      })
      .finally(() => {
        running = false;
      });
  };

  const timer = setInterval(tick, CLEANUP_INTERVAL_MS);
  tick();

  return {
    stop: async () => {
      stopped = true;
      clearInterval(timer);
      await inFlight;
    },
  };
}
