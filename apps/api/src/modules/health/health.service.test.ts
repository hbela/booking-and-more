import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@bam/db";
import { HealthService } from "./health.service.js";

describe("health service Redis readiness", () => {
  const prisma = { $queryRaw: vi.fn().mockResolvedValue([{ one: 1 }]) } as unknown as PrismaClient;

  it("reports configured Redis as down when the shared limiter store cannot answer", async () => {
    const service = new HealthService({
      prisma,
      redis: { ping: vi.fn().mockRejectedValue(new Error("redis://secret@host")) },
      version: "test",
      startedAt: Date.now(),
    });

    const result = await service.readiness();

    expect(result.status).toBe("degraded");
    expect(result.checks.redis).toMatchObject({ status: "down", error: "Error" });
    expect(JSON.stringify(result)).not.toContain("redis://");
  });

  it("reports an omitted optional Redis store as not configured", async () => {
    const service = new HealthService({ prisma, version: "test", startedAt: Date.now() });

    expect((await service.readiness()).checks.redis.status).toBe("not_configured");
  });
});
