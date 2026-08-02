/**
 * Building a link to one of our own screens, in the right language.
 * docs/phase-9-owner-language-and-return-paths.md §2.
 *
 * ## Why this is here and not in either app
 *
 * The API builds these (an invitation link, a Stripe return URL, the redirect
 * baked into a Payment Link) and so does the worker (every link in every email).
 * Neither can see the other, and both had independently written
 * `` `${appBaseUrl}/dashboard/subscription` `` — which is the *Hungarian* URL,
 * because `next-intl` runs `localePrefix: "as-needed"` with `defaultLocale:
 * "hu"`. An English owner received an English email that linked them to a
 * Hungarian screen.
 *
 * What a link to a screen looks like is a fact about the product, not about
 * whichever process happened to emit it, so it lives in the package both
 * already treat as shared vocabulary.
 */

/**
 * Locales the web app routes. Mirrors `apps/web/src/i18n/routing.ts` by value;
 * `@bam/notification-engine` holds the same list for templates, and
 * `app-url.test.ts` is where the three are asserted to agree.
 */
export const APP_LOCALES = ["hu", "en"] as const;

export type AppLocale = (typeof APP_LOCALES)[number];

/** The locale whose URLs carry no prefix. `routing.defaultLocale`. */
export const DEFAULT_APP_LOCALE: AppLocale = "hu";

export function isAppLocale(value: unknown): value is AppLocale {
  return typeof value === "string" && (APP_LOCALES as readonly string[]).includes(value);
}

export interface AppUrlInput {
  /** `APP_BASE_URL`. A trailing slash is tolerated. */
  baseUrl: string;
  /** Absolute path within the app, leading slash included: `/dashboard`. */
  path: string;
  /**
   * Usually `Tenant.defaultLanguage`, which is a plain string column and so can
   * hold anything. An unrecognised value falls back to {@link
   * DEFAULT_APP_LOCALE} rather than being interpolated: a wrong-language page is
   * a defect, a malformed URL is a dead end, and only one of those is
   * recoverable by the person reading it.
   */
  locale: string | null | undefined;
}

/**
 * `https://app.example/en/dashboard/subscription`, or
 * `https://app.example/dashboard/subscription` for Hungarian.
 *
 * **The default locale deliberately gets no prefix.** `/hu/dashboard` also
 * works — next-intl's middleware redirects it to the bare path — but emitting
 * the canonical form means the URL in an email is the URL in the address bar,
 * and one fewer redirect on a link somebody may open on a slow phone.
 */
export function buildAppUrl({ baseUrl, path, locale }: AppUrlInput): string {
  const base = baseUrl.replace(/\/+$/u, "");
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const resolved = resolveAppLocale(locale);
  const prefix = resolved === DEFAULT_APP_LOCALE ? "" : `/${resolved}`;

  return `${base}${prefix}${normalizedPath}`;
}

/**
 * The routable locale for a stored language value.
 *
 * Region subtags are dropped for the same reason `@bam/notification-engine`'s
 * `normalizeLocale` drops them: routes are per language, and `hu-HU` and `hu-SK`
 * would resolve to the same set of pages.
 */
export function resolveAppLocale(value: string | null | undefined): AppLocale {
  if (value === null || value === undefined) return DEFAULT_APP_LOCALE;

  const primary = value.trim().toLowerCase().split(/[-_]/u)[0];

  return isAppLocale(primary) ? primary : DEFAULT_APP_LOCALE;
}
