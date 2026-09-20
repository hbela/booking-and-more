import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadEnv } from "@bam/config";
import { buildApp, type AppInstance } from "./app.js";

const databaseUrl = process.env["TEST_DATABASE_URL"];
describe.skipIf(!databaseUrl)("invite-only launch", () => {
  let app: AppInstance;
  const email = `cohort-${randomUUID()}@example.test`;
  let cookie: string;
  let userId: string;
  const verificationUrls: string[] = [];
  beforeAll(async () => {
    const env = loadEnv({
      source: {
        NODE_ENV: "test",
        LOG_LEVEL: "silent",
        DATABASE_URL: databaseUrl!,
        APP_BASE_URL: "http://localhost:3000",
        API_BASE_URL: "http://localhost:3001",
        BETTER_AUTH_SECRET: "a-test-secret-with-at-least-32-characters",
        CUSTOMER_PII_ENCRYPTION_KEY: "11".repeat(32),
        CUSTOMER_PII_BLIND_INDEX_KEY: "22".repeat(32),
        LAUNCH_ACCESS_MODE: "invite_only",
        LAUNCH_OWNER_EMAIL_ALLOWLIST: email.toUpperCase(),
      },
      loadDotenvFile: false,
    });
    app = await buildApp({
      env,
      logger: false,
      rateLimit: false,
      sendVerificationEmail: async ({ url }) => {
        verificationUrls.push(url);
      },
    });
    const signup = await app.inject({
      method: "POST",
      url: "/v1/auth/sign-up/email",
      payload: { name: "Cohort owner", email, password: "a-long-test-password" },
    });
    expect(signup.statusCode).toBe(200);
    cookie = signup.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    userId = (await app.prisma.user.findUniqueOrThrow({ where: { email } })).id;
  });
  afterAll(async () => {
    await app?.close();
  });
  it("requires verification even for an allowlisted owner, then permits creation", async () => {
    const payload = { name: "Cohort clinic", slug: `cohort-${randomUUID()}` };
    const denied = await app.inject({
      method: "POST",
      url: "/v1/tenants",
      headers: { cookie },
      payload,
    });
    expect(denied.statusCode).toBe(403);
    const resent = await app.inject({
      method: "POST",
      url: "/v1/auth/send-verification-email",
      headers: { cookie },
      payload: { email, callbackURL: "http://localhost:3000/dashboard" },
    });
    expect(resent.statusCode).toBe(200);
    expect(verificationUrls.length).toBeGreaterThanOrEqual(2);
    const verificationUrl = new URL(verificationUrls.at(-1)!);
    const verified = await app.inject({
      method: "GET",
      url: verificationUrl.pathname + verificationUrl.search,
    });
    expect(verified.statusCode).toBeLessThan(400);
    expect((await app.prisma.user.findUniqueOrThrow({ where: { id: userId } })).emailVerified).toBe(
      true,
    );
    const allowed = await app.inject({
      method: "POST",
      url: "/v1/tenants",
      headers: { cookie },
      payload,
    });
    expect(allowed.statusCode).toBe(201);
    const tenantId = (JSON.parse(allowed.body) as { id: string }).id;
    await app.prisma.user.update({ where: { id: userId }, data: { emailVerified: false } });
    const checkout = await app.inject({
      method: "POST",
      url: "/v1/billing/subscribe",
      headers: { cookie, "x-tenant-id": tenantId },
      payload: { plan: "STARTER" },
    });
    expect(checkout.statusCode).toBe(403);
  });
  it("refuses a verified owner outside the allowlist", async () => {
    await app.prisma.user.update({
      where: { id: userId },
      data: { email: `outside-${randomUUID()}@example.test`, emailVerified: true },
    });
    const denied = await app.inject({
      method: "POST",
      url: "/v1/tenants",
      headers: { cookie },
      payload: { name: "Outside", slug: `outside-${randomUUID()}` },
    });
    expect(denied.statusCode).toBe(403);
  });
});
