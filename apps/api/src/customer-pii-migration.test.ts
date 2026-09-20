import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPrismaClient, type PrismaClient } from "@bam/db";
import { createCustomerPii } from "@bam/crypto";

const run = promisify(execFile);
const testUrl = process.env["TEST_DATABASE_URL"];
const local = testUrl && ["localhost", "127.0.0.1"].includes(new URL(testUrl).hostname);
const dbName = `bam_rehearsal_pii_${randomBytes(6).toString("hex")}`;
const root = fileURLToPath(new URL("../../../", import.meta.url));

describe.skipIf(!local)("preserved-data PII migration", () => {
  let admin: PrismaClient;
  let prisma: PrismaClient;
  let env: NodeJS.ProcessEnv;
  let created = false;
  beforeAll(async () => {
    admin = createPrismaClient({ databaseUrl: testUrl! });
    // Only our freshly generated, strictly validated rehearsal name is interpolated.
    if (!/^bam_rehearsal_pii_[0-9a-f]{12}$/u.test(dbName)) throw new Error("Invalid test database");
    await admin.$executeRawUnsafe(`CREATE DATABASE "${dbName}"`);
    created = true;
    const url = new URL(testUrl!);
    url.pathname = `/${dbName}`;
    env = {
      PATH: process.env["PATH"],
      SystemRoot: process.env["SystemRoot"],
      TEMP: process.env["TEMP"],
      NODE_ENV: "production",
      DATABASE_URL: url.toString(),
      APP_BASE_URL: "https://app.example.test",
      API_BASE_URL: "https://api.example.test",
      BETTER_AUTH_SECRET: "rehearsal-only-auth-secret-with-32-characters",
      CUSTOMER_PII_ENCRYPTION_KEY: "11".repeat(32),
      CUSTOMER_PII_BLIND_INDEX_KEY: "22".repeat(32),
      LAUNCH_ACCESS_MODE: "public",
    };
    await run(
      process.execPath,
      [`${root}/packages/db/node_modules/prisma/build/index.js`, "migrate", "deploy"],
      { cwd: `${root}/packages/db`, env },
    );
    prisma = createPrismaClient({ databaseUrl: url.toString() });
  }, 60_000);
  afterAll(async () => {
    await prisma?.$disconnect();
    if (created) await admin.$executeRawUnsafe(`DROP DATABASE "${dbName}"`);
    await admin?.$disconnect();
  });
  const command = (args: string[], overrides: NodeJS.ProcessEnv = {}) =>
    run(process.execPath, ["apps/api/scripts/backfill-customer-pii.mjs", ...args], {
      cwd: root,
      env: { ...env, ...overrides },
    });
  it("archives test billing once, preserves trial history, and quarantines only billing work", async () => {
    const tenant = await prisma.tenant.create({
      data: { slug: "billing-rehearsal", name: "Rehearsal", status: "ACTIVE" },
    });
    const trialUsedAt = new Date("2026-01-01T00:00:00Z");
    await prisma.subscription.create({
      data: {
        tenantId: tenant.id,
        plan: "STARTER",
        status: "ACTIVE",
        stripeCustomerId: "cus_test_rehearsal",
        stripeSubscriptionId: "sub_test_rehearsal",
        trialUsedAt,
      },
    });
    await prisma.stripeEvent.create({
      data: {
        id: "evt_test_rehearsal",
        type: "customer.subscription.updated",
        payload: { livemode: false, data: { object: { id: "sub_test_rehearsal" } } },
      },
    });
    const billing = await prisma.outboxEvent.create({
      data: {
        tenantId: tenant.id,
        aggregateType: "Tenant",
        aggregateId: tenant.id,
        eventType: "SUBSCRIPTION_LINK_REQUESTED",
        payload: {},
      },
    });
    const booking = await prisma.outboxEvent.create({
      data: {
        tenantId: tenant.id,
        aggregateType: "Booking",
        aggregateId: "example",
        eventType: "BOOKING_CONFIRMED",
        payload: {},
      },
    });
    const notification = await prisma.notification.create({
      data: {
        tenantId: tenant.id,
        type: "SUBSCRIPTION_LINK",
        channel: "EMAIL",
        recipient: "owner@example.test",
        template: "subscription-link",
        locale: "en",
        scheduledAt: new Date(),
        dedupeKey: "rehearsal-billing",
        payload: {},
      },
    });
    const transition = (args: string[]) =>
      run(
        process.execPath,
        [
          "--import",
          "./apps/api/src/test-support/stripe-rehearsal-loader.mjs",
          "apps/api/scripts/transition-test-billing.mjs",
          "--tenant",
          tenant.id,
          ...args,
        ],
        {
          cwd: root,
          env: {
            ...env,
            BILLING_MODE: "test",
            STRIPE_SECRET_KEY: "sk_test_rehearsal",
            STRIPE_WEBHOOK_SECRET: "whsec_test",
            STRIPE_PRICE_STARTER: "price_test_starter",
            STRIPE_PRICE_PROFESSIONAL: "price_test_pro",
          },
        },
      );
    await transition([]);
    expect(await prisma.billingTransitionArchive.count()).toBe(0);
    const args = ["--apply", "--maintenance", "--database", dbName];
    await transition(args);
    await transition(args);
    const subscription = await prisma.subscription.findUniqueOrThrow({
      where: { tenantId: tenant.id },
    });
    expect(subscription.stripeSubscriptionId).toBeNull();
    expect(subscription.trialUsedAt).toEqual(trialUsedAt);
    expect(subscription.status).toBe("CANCELED");
    expect(await prisma.billingTransitionArchive.count()).toBe(1);
    expect((await prisma.outboxEvent.findUniqueOrThrow({ where: { id: billing.id } })).status).toBe(
      "PROCESSED",
    );
    expect((await prisma.outboxEvent.findUniqueOrThrow({ where: { id: booking.id } })).status).toBe(
      "PENDING",
    );
    expect(
      (await prisma.notification.findUniqueOrThrow({ where: { id: notification.id } })).status,
    ).toBe("SKIPPED");
    expect(
      (await prisma.stripeEvent.findUniqueOrThrow({ where: { id: "evt_test_rehearsal" } }))
        .lastError,
    ).toBe("QUARANTINED_TEST_TO_LIVE");
  }, 60_000);
  it("resumes partial conversion, validates indexes, removes legacy values and refuses wrong keys", async () => {
    const pii = createCustomerPii("11".repeat(32), "22".repeat(32));
    const tenant = await prisma.tenant.create({
      data: { slug: "pii-rehearsal", name: "Rehearsal" },
    });
    const customer = await prisma.customer.create({
      data: {
        tenantId: tenant.id,
        fullName: pii.seal("Test Patient"),
        email: "Patient@Example.test",
        normalizedEmail: "patient@example.test",
      },
    });
    const provider = await prisma.provider.create({
      data: { tenantId: tenant.id, displayName: "Rehearsal", timezone: "Europe/Budapest" },
    });
    const service = await prisma.service.create({
      data: { tenantId: tenant.id, name: "Rehearsal", slug: "test", durationMinutes: 30 },
    });
    const booking = await prisma.booking.create({
      data: {
        tenantId: tenant.id,
        customerId: customer.id,
        providerId: provider.id,
        serviceId: service.id,
        reference: "TEST-1",
        startAt: new Date("2030-01-01T09:00:00Z"),
        endAt: new Date("2030-01-01T09:30:00Z"),
        customerNameSnapshot: "Test Patient",
        customerEmailSnapshot: "Patient@Example.test",
        serviceNameSnapshot: "Rehearsal",
      },
    });
    await command([]);
    expect((await prisma.customer.findUniqueOrThrow({ where: { id: customer.id } })).email).toBe(
      "Patient@Example.test",
    );
    await expect(command(["--apply"])).rejects.toThrow();
    const applyArgs = ["--apply", "--maintenance", "--database", dbName];
    await command(applyArgs);
    const first = await prisma.customer.findUniqueOrThrow({ where: { id: customer.id } });
    await command(applyArgs);
    const second = await prisma.customer.findUniqueOrThrow({ where: { id: customer.id } });
    expect(second.email).toBe(first.email);
    expect(pii.open(second.fullName)).toBe("Test Patient");
    expect(second.emailBlindIndex).toBe(pii.index(tenant.id, "patient@example.test"));
    expect(
      pii.open(
        (await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } }))
          .customerNameSnapshot,
      ),
    ).toBe("Test Patient");
    await expect(command(["--verify"])).rejects.toThrow();
    await expect(
      command(["--finalize", "--maintenance", "--database", dbName], {
        CUSTOMER_PII_ENCRYPTION_KEY: "33".repeat(32),
      }),
    ).rejects.toThrow();
    expect(second.normalizedEmail).toBe("patient@example.test");
    await command(["--finalize", "--maintenance", "--database", dbName]);
    await command(["--verify"]);
    expect(
      (await prisma.customer.findUniqueOrThrow({ where: { id: customer.id } })).normalizedEmail,
    ).toBeNull();
    expect(await prisma.booking.count()).toBe(1);
  }, 60_000);
});
