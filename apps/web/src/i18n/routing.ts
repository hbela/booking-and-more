import { defineRouting } from "next-intl/routing";

/**
 * Locale routing. PRD §12.5 — Hungarian and English at launch, German and
 * French planned.
 *
 * Hungarian is the default because the pilot tenant (Sunshine Dental) is
 * Hungarian. `localePrefix: "as-needed"` keeps the default locale's URLs clean
 * (`/book` rather than `/hu/book`) while still giving every other locale an
 * explicit, shareable prefix.
 */
export const routing = defineRouting({
  locales: ["hu", "en"],
  defaultLocale: "hu",
  localePrefix: "as-needed",
});

export type Locale = (typeof routing.locales)[number];

/**
 * Our own top-level routes. Everything else under `/[locale]/` is a tenant slug.
 *
 * Kept as a list because `[tenantSlug]` is a catch-all: Next matches the static
 * segments first, so this only has to agree with the directories beside
 * `[tenantSlug]` in `app/[locale]/`. A segment added there and forgotten here
 * gets tenant treatment — which means its language stops following the browser,
 * not that it breaks.
 */
const APP_SEGMENTS = new Set([
  "admin",
  "booking",
  "dashboard",
  "invitations",
  "platform",
  "sign-in",
  "sign-up",
]);

/**
 * Is this a tenant's own public page?
 *
 * `/medicare`, `/medicare/book`, `/en/medicare/book` — but not `/dashboard`, and
 * not `/booking/manage/…`, which is a customer's own link and carries whatever
 * locale the confirmation email was written in.
 *
 * Used by the middleware to turn *off* browser-language detection for these
 * paths only. See `proxy.ts` for why.
 */
export function isTenantPath(pathname: string): boolean {
  const segments = pathname.split("/").filter(Boolean);

  const withoutLocale =
    segments[0] !== undefined && (routing.locales as readonly string[]).includes(segments[0])
      ? segments.slice(1)
      : segments;

  const [first, second] = withoutLocale;

  if (first === undefined || APP_SEGMENTS.has(first)) return false;

  // Exactly `/{slug}` or `/{slug}/book`. Nothing deeper is a tenant page today,
  // and matching on the prefix alone would quietly claim any future route under
  // one — including `/{slug}/book/anything`.
  if (withoutLocale.length === 1) return true;

  return withoutLocale.length === 2 && second === "book";
}
