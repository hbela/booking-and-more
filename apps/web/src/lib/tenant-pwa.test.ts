import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import QRCode from "qrcode";
import { tenantAppManifest, validTenantApp } from "./tenant-pwa";
import { GET as manifest } from "../app/api/pwa/[tenantSlug]/[audience]/manifest/route";
import { GET as qr } from "../app/api/pwa/[tenantSlug]/[audience]/qr/route";

const tenant = { id: "tenant-1", slug: "wellness-demo", name: "Wellness Demo" };
const params = (audience = "staff", tenantSlug = tenant.slug) => ({
  params: Promise.resolve({ tenantSlug, audience }),
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("organization installations", () => {
  it("keeps identity across languages and slug changes, but separates organizations and audiences", () => {
    const staff = tenantAppManifest(tenant, "staff", "en");
    expect(staff.id).toBe(tenantAppManifest({ ...tenant, slug: "renamed" }, "staff", "hu").id);
    expect(staff.id).not.toBe(tenantAppManifest(tenant, "patient", "en").id);
    expect(staff.id).not.toBe(tenantAppManifest({ ...tenant, id: "tenant-2" }, "staff", "en").id);
    expect(staff.start_url).toBe("/en/wellness-demo/sign-in");
    expect(tenantAppManifest(tenant, "patient", "hu").start_url).toBe("/wellness-demo/book");
  });
  it.each(["../another", "foo/bar", "foo?tenant=other", "https://evil.test", ""])(
    "rejects unsafe slug %s",
    (slug) => {
      expect(validTenantApp(slug, "staff")).toBe(false);
    },
  );
  it("fetches public branding without passing session credentials", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(Response.json({ ...tenant, privateField: "never-include" }));
    vi.stubGlobal("fetch", fetcher);
    vi.stubEnv("NEXT_PUBLIC_API_BASE_URL", "https://api.example.test");
    const response = await manifest(
      new NextRequest("https://app.test/api/pwa/wellness-demo/staff/manifest?locale=en", {
        headers: { cookie: "session=secret" },
      }),
      params(),
    );
    expect(fetcher).toHaveBeenCalledWith(
      "https://api.example.test/v1/public/tenants/wellness-demo",
      { cache: "no-store", signal: expect.any(AbortSignal) },
    );
    expect(response.headers.get("content-type")).toContain("application/manifest+json");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({
      name: "Wellness Demo · Staff",
      start_url: "/en/wellness-demo/sign-in",
    });
  });
  it.each([404, 500])(
    "does not invent branding when the tenant lookup fails (%s)",
    async (status) => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status })));
      expect((await manifest(new NextRequest("https://app.test/manifest"), params())).status).toBe(
        status === 404 ? 404 : 503,
      );
    },
  );
  it("rejects an unsupported audience before fetching", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    expect(
      (await manifest(new NextRequest("https://app.test/manifest"), params("admin"))).status,
    ).toBe(404);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("encodes the public installation link, not proxy origin or request credentials", async () => {
    vi.stubEnv("APP_BASE_URL", "https://app.booking.appointer.hu");
    const encoder = vi.spyOn(QRCode, "toString");
    const response = await qr(
      new NextRequest(
        "http://internal:3000/api/pwa/wellness-demo/patient/qr?locale=en&token=secret",
      ),
      params("patient"),
    );
    expect(encoder).toHaveBeenCalledWith(
      "https://app.booking.appointer.hu/en/wellness-demo/install/patient",
      expect.objectContaining({ margin: 4, type: "svg" }),
    );
    expect(response.headers.get("content-type")).toBe("image/svg+xml");
    expect(await response.text()).toContain("<svg");
  });
});
