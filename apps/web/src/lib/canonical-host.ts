/**
 * Hosts that only redirect to the app (docs/public-site-and-legal-pages.md §2.2).
 *
 * `booking.appointer.hu` is the website registered with Stripe, but the app
 * cannot simply answer on it too: the API's CORS allow-list and Better Auth's
 * trusted origins name `APP_BASE_URL` alone, and session cookies are
 * host-bound, so signing in there would fail. A host is redirected only when it
 * is listed in `CANONICAL_REDIRECT_HOSTS`, so a host nobody named — a tenant
 * custom domain one day, `localhost` today — is never touched.
 *
 * Returns the target URL, or null to serve the request normally.
 */
export function canonicalRedirect(
  url: URL,
  host: string | null,
  env: { APP_BASE_URL?: string | undefined; CANONICAL_REDIRECT_HOSTS?: string | undefined },
): string | null {
  if (!host || !env.APP_BASE_URL || !env.CANONICAL_REDIRECT_HOSTS) return null;

  const hosts = env.CANONICAL_REDIRECT_HOSTS.split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  const requested = host.toLowerCase().replace(/:\d+$/u, "");
  if (!hosts.includes(requested)) return null;

  let target: URL;
  try {
    target = new URL(env.APP_BASE_URL);
  } catch {
    return null;
  }
  // Never redirect a host to itself: a misconfiguration would loop forever.
  if (target.hostname === requested) return null;

  target.pathname = url.pathname;
  target.search = url.search;
  return target.toString();
}
