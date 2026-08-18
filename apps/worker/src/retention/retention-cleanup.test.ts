import { describe, expect, it, vi } from "vitest";
import { createPrismaClient, type PrismaClient } from "@bam/db";
import { runRetentionBatch, type RetentionPolicy } from "./retention-cleanup.js";

const policies: RetentionPolicy[] = [
  "expiredSessions",
  "expiredIdempotencyKeys",
  "staleBookingHolds",
  "expiredCalendarOauthStates",
  "completedOutboxEvents",
  "terminalNotificationPayloads",
  "processedStripePayloads",
  "expiredBookingManagementTokens",
  "oldAuditLogs",
];

describe("retention cleanup", () => {
  it("runs every policy as a bounded batch and reports remaining backlog age", async () => {
    const oldest = new Date("2025-01-01T00:00:00.000Z");
    const queryRaw = vi
      .fn()
      .mockResolvedValueOnce(
        policies.map((policy, index) => ({ policy, affected: BigInt(index + 1) })),
      )
      .mockResolvedValueOnce([{ oldest_eligible_at: oldest }]);
    const prisma = { $queryRaw: queryRaw } as unknown as PrismaClient;

    const summary = await runRetentionBatch(prisma, {
      now: new Date("2026-08-18T12:00:00.000Z"),
      batchSize: 37,
    });

    expect(summary.counts).toEqual(
      Object.fromEntries(policies.map((policy, index) => [policy, index + 1])),
    );
    expect(summary.oldestRemainingEligibleAt).toEqual(oldest);
    expect(summary.durationMs).toBeGreaterThanOrEqual(0);
    expect(queryRaw).toHaveBeenCalledTimes(2);

    const cleanupSql = (queryRaw.mock.calls[0]?.[0] as TemplateStringsArray).join("?");
    expect(cleanupSql).toContain("LIMIT");
    expect(cleanupSql).toContain("pg_try_advisory_xact_lock");
    expect(cleanupSql).toContain('UPDATE "stripe_events"');
    expect(cleanupSql).toContain('SET "management_token_hash" = NULL');
    expect(cleanupSql).toContain('DELETE FROM "audit_logs"');
    expect(queryRaw.mock.calls[0]).toContain(37);
  });
});

const databaseUrl = process.env["TEST_DATABASE_URL"];

describe.skipIf(!databaseUrl)("retention cleanup SQL", () => {
  it("executes every policy against PostgreSQL and rolls the batch back", async () => {
    const prisma = createPrismaClient({ databaseUrl: databaseUrl! });
    const rollback = new Error("ROLLBACK_RETENTION_SMOKE");

    try {
      await expect(
        prisma.$transaction(async (transaction) => {
          const summary = await runRetentionBatch(transaction as unknown as PrismaClient, {
            batchSize: 1,
          });
          expect(Object.keys(summary.counts)).toHaveLength(policies.length);
          throw rollback;
        }),
      ).rejects.toBe(rollback);
    } finally {
      await prisma.$disconnect();
    }
  });
});
