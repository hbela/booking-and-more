import type { PrismaClient } from "@bam/db";
import type { Logger } from "@bam/observability";

/** Aggregate-only diagnostics: customer payloads must never reach monitoring. */
export async function reportProcessingHealth(prisma: PrismaClient, log: Logger): Promise<void> {
  const overdue = new Date(Date.now() - 5 * 60_000);
  const [outboxOverdue, outboxFailed, notificationsOverdue, notificationsFailed, stripeOverdue] =
    await Promise.all([
      prisma.outboxEvent.count({
        where: { status: { in: ["PENDING", "PROCESSING"] }, availableAt: { lt: overdue } },
      }),
      prisma.outboxEvent.count({ where: { status: "FAILED" } }),
      prisma.notification.count({
        where: { status: { in: ["PENDING", "SENDING"] }, scheduledAt: { lt: overdue } },
      }),
      prisma.notification.count({ where: { status: "FAILED" } }),
      prisma.stripeEvent.count({ where: { processedAt: null, receivedAt: { lt: overdue } } }),
    ]);
  const metrics = {
    outboxOverdue,
    outboxFailed,
    notificationsOverdue,
    notificationsFailed,
    stripeOverdue,
  };
  if (Object.values(metrics).some((count) => count > 0))
    log.warn(metrics, "worker: processing needs attention");
  else log.info(metrics, "worker: processing healthy");
}
