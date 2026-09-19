import { type NextRequest } from "next/server";
import QRCode from "qrcode";
import { tenantAppPaths, validTenantApp } from "@/lib/tenant-pwa";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ tenantSlug: string; audience: string }> },
) {
  const { tenantSlug, audience } = await params;
  if (!validTenantApp(tenantSlug, audience)) return new Response(null, { status: 404 });
  const locale = request.nextUrl.searchParams.get("locale") === "en" ? "en" : "hu";
  // Pin the public origin behind Coolify; local development uses the request URL.
  const origin = process.env["APP_BASE_URL"] ?? request.nextUrl.origin;
  const target = new URL(tenantAppPaths(tenantSlug, audience, locale).install, origin).href;
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
