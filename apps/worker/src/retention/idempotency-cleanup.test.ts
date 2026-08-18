import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createPrismaClient, type PrismaClient } from "@bam/db";

import { deleteExpiredIdempotencyKeys } from "./idempotency-cleanup.js";

const databaseUrl = process.env["TEST_DATABASE_URL"];
const suffix = Math.random().toString(36).slice(2, 10);

describe.skipIf(!databaseUrl)("idempotency retention", () => {
  let prisma: PrismaClient;
  let tenantId: string;

  beforeEach(async () => {
    prisma ??= createPrismaClient({ databaseUrl: databaseUrl! });
    tenantId = (
      await prisma.tenant.create({
        data: {
          slug: `retention-${suffix}-${Math.random().toString(36).slice(2, 8)}`,
          name: "Retention Clinic",
        },
      })
    ).id;
  });

  afterAll(async () => prisma?.$disconnect());

  it("deletes expired replay bodies but leaves live keys", async () => {
    const row = (key: string, expiresAt: Date, secret: string) =>
      prisma.idempotencyKey.create({
        data: {
          tenantId,
          operation: "test",
          key,
          requestHash: key,
          responseStatus: 200,
          responseBody: { managementToken: secret },
          expiresAt,
        },
      });

    await row("expired", new Date(Date.now() - 1_000), "remove-me");
    await row("live", new Date(Date.now() + 60_000), "keep-for-replay");

    expect(await deleteExpiredIdempotencyKeys(prisma)).toBeGreaterThanOrEqual(1);
    expect(
      await prisma.idempotencyKey.findFirst({ where: { tenantId, key: "expired" } }),
    ).toBeNull();
    expect(
      await prisma.idempotencyKey.findFirst({ where: { tenantId, key: "live" } }),
    ).not.toBeNull();
  });
});
