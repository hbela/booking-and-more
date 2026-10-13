import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@bam/db";
import type { Logger } from "@bam/observability";
import {
  createProcessingProbe,
  measureProcessing,
  processingStatus,
  type ProcessingMetrics,
} from "./processing-health.js";

const healthy: ProcessingMetrics = {
  outboxOverdue: 0,
  outboxRecentlyFailed: 0,
  notificationsOverdue: 0,
  notificationsRecentlyFailed: 0,
  stripeOverdue: 0,
  outboxFailed: 0,
  notificationsFailed: 0,
};

const prisma = {} as PrismaClient;
const logger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });

describe("processingStatus", () => {
  it("is ok when nothing is stuck or newly failed", () => {
    expect(processingStatus(healthy)).toBe("ok");
  });

  it("ignores failures that are only old: FAILED rows never go away", () => {
    expect(processingStatus({ ...healthy, outboxFailed: 4, notificationsFailed: 9 })).toBe("ok");
  });

  it.each([
    "outboxOverdue",
    "outboxRecentlyFailed",
    "notificationsOverdue",
    "notificationsRecentlyFailed",
    "stripeOverdue",
  ] as const)("is error when %s is non-zero", (key) => {
    expect(processingStatus({ ...healthy, [key]: 1 })).toBe("error");
  });
});

describe("measureProcessing", () => {
  it("bounds overdue at five minutes, recent failures at thirty, Stripe past its orphan window", async () => {
    const calls: { model: string; where: Record<string, unknown> }[] = [];
    const counter = (model: string) => ({
      count: ({ where }: { where: Record<string, unknown> }) => {
        calls.push({ model, where });
        return Promise.resolve(0);
      },
    });
    const fake = {
      outboxEvent: counter("outbox"),
      notification: counter("notification"),
      stripeEvent: counter("stripe"),
    } as unknown as PrismaClient;
    const now = new Date("2026-10-12T12:00:00Z");

    await measureProcessing(fake, { now, stripeOrphanTimeoutMs: 15 * 60_000 });

    const fiveMinutesAgo = new Date("2026-10-12T11:55:00Z");
    const thirtyMinutesAgo = new Date("2026-10-12T11:30:00Z");
    const twentyMinutesAgo = new Date("2026-10-12T11:40:00Z");
    expect(calls).toContainEqual({
      model: "notification",
      where: { status: { in: ["PENDING", "SENDING"] }, scheduledAt: { lt: fiveMinutesAgo } },
    });
    expect(calls).toContainEqual({
      model: "outbox",
      where: { status: "FAILED", availableAt: { gte: thirtyMinutesAgo } },
    });
    expect(calls).toContainEqual({
      model: "notification",
      where: { status: "FAILED", updatedAt: { gte: thirtyMinutesAgo } },
    });
    expect(calls).toContainEqual({
      model: "stripe",
      // An unattributed event is retried for 15 minutes on purpose; only after
      // that window plus the margin is it stuck.
      where: { processedAt: null, receivedAt: { lt: twentyMinutesAgo } },
    });
  });
});

describe("createProcessingProbe", () => {
  it("reports what the measurement says", async () => {
    const log = logger();
    const probe = createProcessingProbe(prisma, log as unknown as Logger, {
      measure: () => Promise.resolve({ ...healthy, notificationsOverdue: 2 }),
    });
    await expect(probe()).resolves.toBe("error");
    expect(log.warn).toHaveBeenCalledOnce();
  });

  it("reports error when the database cannot be read", async () => {
    const probe = createProcessingProbe(prisma, logger() as unknown as Logger, {
      measure: () => Promise.reject(new Error("connection refused")),
    });
    await expect(probe()).resolves.toBe("error");
  });

  it("reports error instead of waiting on a hung database, without stacking queries", async () => {
    vi.useFakeTimers();
    try {
      const measure = vi.fn(() => new Promise<ProcessingMetrics>(() => {}));
      const probe = createProcessingProbe(prisma, logger() as unknown as Logger, {
        timeoutMs: 10_000,
        measure,
      });

      const first = probe();
      await vi.advanceTimersByTimeAsync(10_000);
      await expect(first).resolves.toBe("error");

      // The first query never returned, so the next beat must not start another.
      await expect(probe()).resolves.toBe("error");
      expect(measure).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("measures again once the previous measurement has finished", async () => {
    const measure = vi.fn(() => Promise.resolve(healthy));
    const probe = createProcessingProbe(prisma, logger() as unknown as Logger, { measure });
    await expect(probe()).resolves.toBe("ok");
    await expect(probe()).resolves.toBe("ok");
    expect(measure).toHaveBeenCalledTimes(2);
  });
});
