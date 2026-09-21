import { API_BASE_URL } from "@/lib/api-origin";
const API_ORIGIN = new URL(API_BASE_URL).origin;

export function buildContentSecurityPolicy(nonce: string, production: boolean): string {
  return [
    "default-src 'self'",
    "worker-src 'self' blob:",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${production ? "" : " 'unsafe-eval'"}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src 'self' ${API_ORIGIN}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(production ? ["upgrade-insecure-requests"] : []),
  ].join("; ");
}
