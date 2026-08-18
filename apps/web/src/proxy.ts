import { randomBytes } from "node:crypto";
import createMiddleware from "next-intl/middleware";
import { NextRequest } from "next/server";
import { isTenantPath, routing } from "./i18n/routing";
import { buildContentSecurityPolicy } from "./lib/security-headers";

// Tenant booking pages use the tenant's configured language, not the
// visitor's Accept-Language preference. All product-owned screens keep normal
// next-intl detection. See the routing record in the original proxy design.
const withDetection = createMiddleware(routing);
const withoutDetection = createMiddleware({ ...routing, localeDetection: false });

/**
 * A request nonce is required because Next streams inline bootstrap/RSC
 * scripts. The CSP is copied onto the request so Next can nonce its own tags,
 * and onto the response so the browser enforces the same policy.
 */
export function proxy(request: NextRequest) {
  const nonce = randomBytes(16).toString("base64");
  const csp = buildContentSecurityPolicy(nonce, process.env["NODE_ENV"] === "production");
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);

  // next-intl copies the headers from this request into its NextResponse.next
  // or rewrite result, so the nonce reaches Next's renderer without giving up
  // locale detection (or the tenant-page exception to that detection).
  const securedRequest = new NextRequest(request, { headers: requestHeaders });
  const response = isTenantPath(request.nextUrl.pathname)
    ? withoutDetection(securedRequest)
    : withDetection(securedRequest);
  response.headers.set("Content-Security-Policy", csp);
  response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  response.headers.set(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  );
  response.headers.set("X-Frame-Options", "DENY");
  response.headers.set("X-Content-Type-Options", "nosniff");

  if (process.env["NODE_ENV"] === "production") {
    response.headers.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }

  return response;
}

export const config = {
  // Skip API routes, Next internals, and any path containing a dot (static
  // files). The security policy is for documents; static assets inherit it.
  matcher: ["/((?!api|_next|_vercel|.*\\..*).*)"],
};
