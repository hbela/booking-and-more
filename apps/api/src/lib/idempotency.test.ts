import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createPrismaClient, type PrismaClient } from "@bam/db";
import { ErrorCodes } from "@bam/contracts";

import { withIdempotency } from "./idempotency.js";

const databaseUrl = process.env["TEST_DATABASE_URL"];
const suffix = Math.random().toString(36).slice(2, 10);

describe.skipIf(!databaseUrl)("idempotency expiry", () => {
  let prisma: PrismaClient;
  let tenantId: string;

  beforeEach(async () => {
    prisma ??= createPrismaClient({ databaseUrl: databaseUrl! });
    const unique = `${suffix}-${Math.random().toString(36).slice(2, 8)}`;
    tenantId = (
      await prisma.tenant.create({
        data: { slug: `idempotency-${unique}`, name: "Idempotency Clinic" },
      })
    ).id;
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  const run = <T>(key: string, requestBody: unknown, operation: () => Promise<T>) =>
    withIdempotency(
      prisma,
      {
        tenantId,
        operation: "test.operation",
        key,
        requestBody,
        successStatus: 201,
      },
      operation,
    );

  it("replays a completed response before expiry", async () => {
    const operation = vi.fn().mockResolvedValue({ value: "first" });

    expect(await run("replay", { value: 1 }, operation)).toMatchObject({ replayed: false });
    expect(await run("replay", { value: 1 }, operation)).toEqual({
      replayed: true,
      value: { value: "first" },
    });
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("atomically replaces an expired response and permits a new request body", async () => {
    await run("expired", { version: 1 }, async () => ({ managementToken: "old-secret" }));
    await prisma.idempotencyKey.updateMany({
      where: { tenantId, key: "expired" },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });

    const result = await run("expired", { version: 2 }, async () => ({ value: "new" }));

    expect(result).toEqual({ replayed: false, value: { value: "new" } });
    expect(await prisma.idempotencyKey.count({ where: { tenantId, key: "expired" } })).toBe(1);
    expect(
      JSON.stringify(
        (await prisma.idempotencyKey.findFirstOrThrow({ where: { tenantId, key: "expired" } }))
          .responseBody,
      ),
    ).not.toContain("old-secret");
  });

  it("allows recovery from a failed operation after its claim expires", async () => {
    await expect(run("failed", {}, async () => Promise.reject(new Error("boom")))).rejects.toThrow(
      "boom",
    );
    await prisma.idempotencyKey.updateMany({
      where: { tenantId, key: "failed" },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });

    await expect(run("failed", {}, async () => ({ recovered: true }))).resolves.toEqual({
      replayed: false,
      value: { recovered: true },
    });
  });

  it("gives exactly one concurrent request ownership of a new key", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const operation = vi.fn(async () => {
      await gate;
      return { done: true };
    });

    const first = run("race", {}, operation);
    const second = run("race", {}, operation);
    await vi.waitFor(() => expect(operation).toHaveBeenCalledTimes(1));
    release();

    const settled = await Promise.allSettled([first, second]);
    expect(operation).toHaveBeenCalledTimes(1);
    // Depending on scheduling, the follower either observes IN_PROGRESS or
    // arrives just after the owner stores its response and replays it. It must
    // never own and execute the operation itself.
    expect(settled.filter((entry) => entry.status === "fulfilled").length).toBeGreaterThanOrEqual(
      1,
    );
    const rejected = settled.find((entry) => entry.status === "rejected");
    if (rejected !== undefined) {
      expect(rejected.reason).toMatchObject({ code: ErrorCodes.IDEMPOTENCY_KEY_IN_PROGRESS });
    }
  });
});
