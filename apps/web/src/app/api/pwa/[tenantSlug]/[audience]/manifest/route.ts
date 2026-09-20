import { API_BASE_URL } from "@/lib/api-origin";
import { type NextRequest, NextResponse } from "next/server";
import { tenantAppManifest, validTenantApp } from "@/lib/tenant-pwa";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ tenantSlug: string; audience: string }> },
) {
  const { tenantSlug, audience } = await params;
  if (!validTenantApp(tenantSlug, audience)) return new Response(null, { status: 404 });
  const locale = request.nextUrl.searchParams.get("locale") === "en" ? "en" : "hu";
  const base = API_BASE_URL;
  try {
    const response = await fetch(`${base}/v1/public/tenants/${tenantSlug}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) return new Response(null, { status: response.status === 404 ? 404 : 503 });
    const tenant = (await response.json()) as { id: string; name: string; slug: string };
    if (!tenant.id || !tenant.name || tenant.slug !== tenantSlug)
      return new Response(null, { status: 503 });
    return NextResponse.json(tenantAppManifest(tenant, audience, locale), {
      headers: { "Content-Type": "application/manifest+json", "Cache-Control": "no-store" },
    });
  } catch {
    return new Response(null, { status: 503 });
  }
}
