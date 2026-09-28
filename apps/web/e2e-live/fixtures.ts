import { randomUUID } from "node:crypto";
import { expect, test as base, type APIRequestContext } from "@playwright/test";

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

export const test = base.extend<{ live: { api: APIRequestContext; config: LiveConfig } }>({
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
});

export { expect };
