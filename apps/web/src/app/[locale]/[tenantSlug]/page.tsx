import { redirect } from "@/i18n/navigation";

/**
 * A clinic's slug on its own — `/wellness` — sends you to its booking form.
 *
 * Without this the segment matched no page, so `/en/wellness` 404'd. That is a
 * URL people type and share: it is what a clinic puts on a poster, and the
 * shorter form is the one that survives being read out. Redirecting rather than
 * duplicating the page keeps one canonical address for the flow.
 *
 * It also removes a hydration error, though not by fixing its cause. The global
 * `app/not-found.tsx` has to render its own `<html lang="hu">` because nothing
 * wraps it, while the client hydrates against the `<html lang="en">` that
 * `[locale]/layout.tsx` produced — React reports an unpatchable mismatch on
 * `<html>`. Any 404 under a locale still does that; this one address no longer
 * reaches it.
 *
 * `redirect` is the locale-aware one from `@/i18n/navigation`, so an English
 * visitor lands on `/en/wellness/book` rather than the Hungarian page — the
 * client-side counterpart of what `buildAppUrl` does for links built on the
 * server (docs/phase-9-owner-language-and-return-paths.md §2).
 */
export default async function TenantRoot({
  params,
}: {
  params: Promise<{ locale: string; tenantSlug: string }>;
}): Promise<void> {
  const { locale, tenantSlug } = await params;

  // Throws, like next/navigation's. Typed as void rather than never because
  // next-intl's wrapper is not declared to return never.
  redirect({ href: `/${tenantSlug}/book`, locale });
}
