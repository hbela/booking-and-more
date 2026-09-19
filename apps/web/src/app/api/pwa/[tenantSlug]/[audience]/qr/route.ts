import { type NextRequest } from "next/server";
import QRCode from "qrcode";
import { tenantQrTarget, validTenantQr } from "@/lib/tenant-pwa";
import { publicAppTenant } from "@/lib/public-app-tenant";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ tenantSlug: string; audience: string }> },
) {
  const { tenantSlug, audience } = await params;
  if (!validTenantQr(tenantSlug, audience)) return new Response(null, { status: 404 });
  if (audience === "chat") {
    const result = await publicAppTenant(tenantSlug);
    if ("status" in result) return new Response(null, { status: result.status });
    if (result.tenant.features?.assistant !== true)
      return new Response(null, { status: 404, headers: { "Cache-Control": "no-store" } });
  }
  const locale = request.nextUrl.searchParams.get("locale") === "en" ? "en" : "hu";
  // Pin the public origin behind Coolify; local development uses the request URL.
  const origin = process.env["APP_BASE_URL"] ?? request.nextUrl.origin;
  const target = new URL(tenantQrTarget(tenantSlug, audience, locale), origin).href;
  const svg = await QRCode.toString(target, {
    type: "svg",
    errorCorrectionLevel: "M",
    margin: 4,
    width: 256,
  });
  return new Response(svg, {
    headers: {
      "Content-Type": "image/svg+xml",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    },
  });
}
