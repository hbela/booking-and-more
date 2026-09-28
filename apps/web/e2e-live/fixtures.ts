import { randomUUID } from "node:crypto";
import { expect, test as base, type APIRequestContext, type Page } from "@playwright/test";

export const appOrigin = "https://app.booking.appointer.hu";
export const apiOrigin = "https://api.booking.appointer.hu";

interface LiveConfig {
  slug: string;
  email: string;
  serviceId: string | undefined;
  providerId: string | undefined;
}

function configuration(): LiveConfig {
  const slug = process.env["STAGING_E2E_TENANT_SLUG"]?.trim();
  const email = process.env["STAGING_E2E_EMAIL"]?.trim();
  if (!slug || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(slug)) {
    throw new Error("Set STAGING_E2E_TENANT_SLUG to a dedicated staging test tenant.");
  }
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) {
    throw new Error("Set STAGING_E2E_EMAIL to a controlled test inbox.");
  }
  return {
    slug,
    email,
    serviceId: process.env["STAGING_E2E_SERVICE_ID"] || undefined,
    providerId: process.env["STAGING_E2E_PROVIDER_ID"] || undefined,
  };
}

export function allowWrites(): void {
  if (process.env["STAGING_E2E_ALLOW_MUTATIONS"] !== "1") {
    throw new Error(
      "Set STAGING_E2E_ALLOW_MUTATIONS=1 to create/cancel test bookings and consume one chat with a real AI turn.",
    );
  }
}

export const key = (): Record<string, string> => ({ "Idempotency-Key": randomUUID() });

/** Do not print response bodies, credential-bearing URLs, or raw network errors. */
export async function call(
  api: APIRequestContext,
  method: "GET" | "POST" | "DELETE",
  path: string,
  status: number,
  options: { data?: unknown; headers?: Record<string, string> } = {},
) {
  let response;
  try {
    response = await api.fetch(path, { method, maxRetries: 0, ...options });
  } catch {
    throw new Error(`Live ${method} request failed before a response; check staging availability.`);
  }
  expect(response.status(), `Live ${method} response status`).toBe(status);
  return response;
}

interface Tenant {
  id: string;
  slug: string;
  name: string;
  defaultTimezone: string;
}

export async function tenantPreflight(api: APIRequestContext, slug: string): Promise<Tenant> {
  const response = await call(api, "GET", `/v1/public/tenants/${slug}`, 200);
  const tenant = (await response.json()) as Tenant;
  expect(tenant.slug).toBe(slug);
  expect(tenant.id).toBeTruthy();
  return tenant;
}

export interface Owner {
  api: APIRequestContext;
  page: Page;
  tenantId: string;
  headers: Record<string, string>;
}

export async function ownerUsage(owner: Owner) {
  const response = await call(owner.api, "GET", "/v1/billing/subscription", 200, {
    headers: owner.headers,
  });
  return (await response.json()) as {
    chatUsage: { used: number; limit: number | null; remaining: number | null };
    subscription: { plan: string; status: string; pendingPlan: string | null } | null;
  };
}

export async function ownerTokens(owner: Owner) {
  const response = await call(owner.api, "GET", "/v1/assistant/conversations/stats", 200, {
    headers: owner.headers,
  });
  const body = (await response.json()) as { inputTokens: number; outputTokens: number };
  return { inputTokens: body.inputTokens, outputTokens: body.outputTokens };
}

export const test = base.extend<{
  live: { api: APIRequestContext; config: LiveConfig };
  owner: Owner;
}>({
  live: async ({ playwright }, use) => {
    const config = configuration();
    const api = await playwright.request.newContext({
      baseURL: apiOrigin,
      extraHTTPHeaders: { Origin: appOrigin },
      timeout: 40_000,
    });
    try {
      await use({ api, config });
    } finally {
      await api.dispose();
    }
  },
  owner: async ({ playwright, browser, live }, use) => {
    const email = process.env["STAGING_E2E_OWNER_EMAIL"];
    const password = process.env["STAGING_E2E_OWNER_PASSWORD"];
    if (!email || !password)
      throw new Error(
        "Set STAGING_E2E_OWNER_EMAIL and STAGING_E2E_OWNER_PASSWORD in the ignored .env.staging-tests file or CI secrets.",
      );
    const api = await playwright.request.newContext({
      baseURL: apiOrigin,
      extraHTTPHeaders: { Origin: appOrigin },
      timeout: 30_000,
    });
    let context;
    let previousTenantId: string | undefined;
    let activatedTenantId: string | undefined;
    try {
      await call(api, "POST", "/v1/auth/sign-in/email", 200, { data: { email, password } });
      const before = await call(api, "GET", "/v1/me", 200);
      previousTenantId = ((await before.json()) as { tenant?: { id: string } }).tenant?.id;
      const tenant = await tenantPreflight(live.api, live.config.slug);
      await call(api, "POST", `/v1/tenants/${tenant.id}/activate`, 204);
      activatedTenantId = tenant.id;
      const headers = { "X-Tenant-Id": tenant.id };
      const me = await call(api, "GET", "/v1/me", 200, { headers });
      expect(
        ((await me.json()) as { membership?: { role: string } }).membership?.role,
        "Live account must own the selected test tenant",
      ).toBe("OWNER");
      context = await browser.newContext({
        storageState: await api.storageState(),
        locale: "en-GB",
        timezoneId: "Europe/Budapest",
      });
      const page = await context.newPage();
      await use({ api, page, tenantId: tenant.id, headers });
    } finally {
      await context?.close();
      try {
        if (previousTenantId && activatedTenantId && previousTenantId !== activatedTenantId) {
          await call(api, "POST", `/v1/tenants/${previousTenantId}/activate`, 204);
        }
        if (activatedTenantId) await call(api, "POST", "/v1/auth/sign-out", 200, { data: {} });
      } finally {
        await api.dispose();
      }
    }
  },
});

export { expect };
