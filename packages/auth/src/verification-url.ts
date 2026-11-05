/**
 * Sends a verification link's redirect to the web app rather than to the API.
 *
 * Better Auth serves the link from its own origin, and when a sign-up names no
 * `callbackURL` it defaults to `/`, which it redirects to on that same origin.
 * The API has no root route, so the address was verified and the person landed
 * on a JSON 404. The invitation path signs up from the server and has no page to
 * name, so this is decided here for every caller. An absolute callback, which
 * the web app sends with the reader's locale, is left alone.
 */
export function verificationUrlForApp(url: string, appUrl: string): string {
  const parsed = new URL(url);
  const callback = parsed.searchParams.get("callbackURL") ?? "/";
  // "//host" is a scheme-relative absolute URL, not a path on this origin.
  if (!callback.startsWith("/") || callback.startsWith("//")) return url;

  const path = callback === "/" ? "/dashboard" : callback;
  parsed.searchParams.set("callbackURL", `${appUrl.replace(/\/+$/u, "")}${path}`);
  return parsed.toString();
}
