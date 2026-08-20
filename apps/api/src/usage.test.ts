import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadEnv } from "@bam/config";
import { isAppError } from "@bam/contracts";

import { buildApp, type AppInstance } from "./app.js";
import { UsageService } from "./modules/usage/usage.service.js";

/**
 * Usage metering and the quota gate. tech-impl §37 · PRD §11.
 * docs/phase-7-chat-booking.md §9.
 *
 * Two claims are worth a database to prove, and neither can be proved by a unit
 * test of the pure table:
 *
 *  1. The event and its aggregate move together, so the gate on the *next*
 *     request reads a figure that includes this one. A rollup job would pass a
 *     unit test and fail this.
 *  2. The gate refuses before the money is spent, and refuses per tenant.
 */

const databaseUrl = process.env["TEST_DATABASE_URL"];

const RUN = `usg${randomBytes(4).toString("hex")}`;

describe.skipIf(!databaseUrl)("usage metering", () => {
  let app: AppInstance;
  let usage: UsageService;
  const tenantIds: string[] = [];

  beforeAll(async () => {
    const env = loadEnv({
      source: {
        NODE_ENV: "test",
        LOG_LEVEL: "silent",
        APP_BASE_URL: "http://localhost:3000",
        API_BASE_URL: "http://localhost:3001",
        DATABASE_URL: databaseUrl!,
        BETTER_AUTH_SECRET: "test-secret-that-is-at-least-32-characters-long",
      },
      loadDotenvFile: false,
    });

    app = await buildApp({ env, logger: false, rateLimit: false });
    await app.ready();

    usage = new UsageService(app.prisma);
  });

  afterAll(async () => {
    await app.prisma.usageReservation.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await app.prisma.usageEvent.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await app.prisma.usageAggregate.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await app.prisma.subscription.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await app.prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
    await app.close();
  });

  /** A tenant on a plan, with nothing metered against it yet. */
  async function tenantOn(plan: "INTERNAL" | "STARTER" | "PROFESSIONAL"): Promise<string> {
    const label = `${RUN}${tenantIds.length}`;

    const tenant = await app.prisma.tenant.create({
      data: {
        slug: `usage-${label}`,
        name: `Usage ${label}`,
        status: "ACTIVE",
        subscription: { create: { plan, status: plan === "INTERNAL" ? "NOT_APPLICABLE" : "ACTIVE" } },
      },
    });

    tenantIds.push(tenant.id);
    return tenant.id;
  }

  it("moves the aggregate in the same breath as the event", async () => {
    const tenantId = await tenantOn("STARTER");

    await usage.record({
      tenantId,
      category: "VOICE_TRANSCRIPTION",
      quantity: 12,
      provider: "openai",
      model: "gpt-4o-mini-transcribe",
      estimatedCostMinor: 3,
    });

    const events = await app.prisma.usageEvent.findMany({ where: { tenantId } });
    expect(events).toHaveLength(1);
    expect(events[0]?.unit).toBe("seconds");

    const summary = await usage.summary({ tenantId, category: "VOICE_TRANSCRIPTION" });
    expect(summary.consumed).toBe(12);
    expect(summary.limit).toBe(3_000);
  });

  it("adds concurrent calls up rather than letting them race", async () => {
    const tenantId = await tenantOn("STARTER");

    await Promise.all(
      Array.from({ length: 10 }, () =>
        usage.record({ tenantId, category: "VOICE_TRANSCRIPTION", quantity: 3 }),
      ),
    );

    const summary = await usage.summary({ tenantId, category: "VOICE_TRANSCRIPTION" });
    expect(summary.consumed).toBe(30);
  });

  it("refuses a call that would exceed the allowance", async () => {
    const tenantId = await tenantOn("STARTER");

    // One second short of the Starter allowance.
    await usage.record({ tenantId, category: "VOICE_TRANSCRIPTION", quantity: 2_999 });

    // Exactly filling it is allowed — otherwise the last unit is unusable.
    await expect(
      usage.assertAllowed({ tenantId, category: "VOICE_TRANSCRIPTION", requestedQuantity: 1 }),
    ).resolves.toBeUndefined();

    const thrown = await usage
      .assertAllowed({ tenantId, category: "VOICE_TRANSCRIPTION", requestedQuantity: 30 })
      .then(() => null)
      .catch((error: unknown) => error);

    expect(isAppError(thrown)).toBe(true);
    expect(isAppError(thrown) && thrown.code).toBe("USAGE_QUOTA_EXCEEDED");
    // A documented ceiling is expected behaviour, not something to page over.
    expect(isAppError(thrown) && thrown.statusCode).toBe(429);
    expect(isAppError(thrown) && thrown.report).toBe(false);
  });

  it("counts one tenant's spend against that tenant only", async () => {
    const spender = await tenantOn("STARTER");
    const bystander = await tenantOn("STARTER");

    await usage.record({ tenantId: spender, category: "VOICE_TRANSCRIPTION", quantity: 3_000 });

    await expect(
      usage.assertAllowed({ tenantId: spender, category: "VOICE_TRANSCRIPTION", requestedQuantity: 1 }),
    ).rejects.toThrow();

    await expect(
      usage.assertAllowed({
        tenantId: bystander,
        category: "VOICE_TRANSCRIPTION",
        requestedQuantity: 30,
      }),
    ).resolves.toBeUndefined();
  });

  it("leaves an unmetered plan and an unmetered category alone", async () => {
    const internal = await tenantOn("INTERNAL");
    await usage.record({ tenantId: internal, category: "VOICE_TRANSCRIPTION", quantity: 100_000 });

    await expect(
      usage.assertAllowed({
        tenantId: internal,
        category: "VOICE_TRANSCRIPTION",
        requestedQuantity: 30,
      }),
    ).resolves.toBeUndefined();

    // Refusing a booking confirmation to save a fraction of a cent would break
    // the product rather than protect it.
    const starter = await tenantOn("STARTER");
    await usage.record({ tenantId: starter, category: "EMAIL_SENT", quantity: 10_000 });

    await expect(
      usage.assertAllowed({ tenantId: starter, category: "EMAIL_SENT", requestedQuantity: 1 }),
    ).resolves.toBeUndefined();
  });

  it("buckets by calendar month in UTC", async () => {
    const tenantId = await tenantOn("STARTER");

    const august = new Date("2026-08-31T23:30:00Z");
    const september = new Date("2026-09-01T00:30:00Z");

    await usage.record({ tenantId, category: "AI_INPUT_TOKENS", quantity: 100 }, { now: august });
    await usage.record({ tenantId, category: "AI_INPUT_TOKENS", quantity: 5 }, { now: september });

    const rows = await app.prisma.usageAggregate.findMany({
      where: { tenantId, category: "AI_INPUT_TOKENS" },
      orderBy: { period: "asc" },
    });

    expect(rows.map((row) => [row.period, row.quantity])).toEqual([
      ["2026-08", 100],
      ["2026-09", 5],
    ]);
  });

  it("does not let concurrent reservations overspend either token ceiling", async () => {
    const tenantId = await tenantOn("STARTER");
    const attempts = await Promise.allSettled(
      Array.from({ length: 3 }, () =>
        usage.reserveAiCall({ tenantId, inputTokens: 1_000_000, outputTokens: 200_000 }),
      ),
    );

    expect(attempts.filter((result) => result.status === "fulfilled")).toHaveLength(2);
    expect(attempts.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(await app.prisma.usageReservation.count({ where: { tenantId, status: "RESERVED" } })).toBe(2);
  });
});
