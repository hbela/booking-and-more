import { cookies } from "next/headers";
import { setRequestLocale } from "next-intl/server";
import { BookingFlow } from "@/components/booking-flow";
import { redirect } from "@/i18n/navigation";
import { routing } from "@/i18n/routing";
import { LOCALE_PREFERENCE_COOKIE } from "@/lib/locale-preference";

/**
 * A clinic's public booking page. tech-impl §28.
 *
 * `/[tenantSlug]/book` rather than the six sub-routes §28 lists — see the note
 * at the top of BookingFlow for why the steps are state rather than navigation.
 *
 * ## Whose language is this page in?
 *
 * The tenant's, unless the visitor has said otherwise.
 *
 * Browser-language detection is switched off for tenant paths in `proxy.ts`, so
 * an unprefixed URL arrives here as the default locale rather than as whatever
 * the laptop is set to. This is where the actual answer is worked out, because
 * this is the first place the tenant is known.
 *
 * The `bam.locale` cookie is the visitor's own choice, written only by the
 * locale switcher. While it is absent the tenant's `defaultLanguage` wins; once
 * it exists nothing overrides it, or the page would fight the customer who just
 * used the switcher on it.
 */
export default async function BookPage({
  params,
}: {
  params: Promise<{ locale: string; tenantSlug: string }>;
}): Promise<React.ReactElement> {
  const { locale, tenantSlug } = await params;

  const chosen = (await cookies()).get(LOCALE_PREFERENCE_COOKIE)?.value;

  if (chosen === undefined) {
    const preferred = await tenantLanguage(tenantSlug);

    // Only redirect to a locale we actually route. A tenant row saying "de"
    // must not produce `/de/medicare/book`, which is a 404 rather than a
    // wrong-language page (the same reasoning as `resolveAppLocale` in
    // @bam/contracts).
    if (
      preferred !== undefined &&
      preferred !== locale &&
      (routing.locales as readonly string[]).includes(preferred)
    ) {
      redirect({ href: `/${tenantSlug}/book`, locale: preferred });
    }
  }

  setRequestLocale(locale);

  return (
    // The seam for PRD §9.1 white-label branding (phase-11 §2.2).
    //
    // Everything inside `BookingFlow` styles itself with `accent-*` utilities,
    // which `@theme inline` compiles to `var(--accent)` — so redefining that
    // variable on this element re-colours the whole subtree and nothing else in
    // the product. Today it resolves to the product blue and this wrapper
    // changes nothing visible; when a tenant's colour arrives it becomes a
    // `style={{ "--accent": tenant.brandColor }}` here and no other file moves.
    //
    // When that day comes, the supplied colour must be contrast-checked
    // server-side before it lands here, or a tenant can make their own booking
    // button unreadable.
    <div data-tenant-brand>
      <BookingFlow tenantSlug={tenantSlug} />
    </div>
  );
}

/**
 * The tenant's own language, or nothing.
 *
 * Failures are swallowed on purpose: an unreachable API here would otherwise
 * turn a booking page into an error page over a question that only decides which
 * of two correct languages it opens in. `BookingFlow` makes the same call from
 * the browser and has somewhere to report it.
 */
async function tenantLanguage(tenantSlug: string): Promise<string | undefined> {
  const base = process.env["NEXT_PUBLIC_API_BASE_URL"] ?? "http://localhost:3001";

  try {
    const response = await fetch(`${base}/v1/public/tenants/${encodeURIComponent(tenantSlug)}`, {
      // The booking page is not cached per tenant today, and a language that
      // changes on the hour is not a problem anybody has.
      next: { revalidate: 300 },
    });

    if (!response.ok) return undefined;

    const tenant = (await response.json()) as { defaultLanguage?: string };
    return tenant.defaultLanguage;
  } catch {
    return undefined;
  }
}
