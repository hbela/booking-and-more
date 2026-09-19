import { notFound } from "next/navigation";
import { setRequestLocale } from "next-intl/server";
import type { Metadata } from "next";
import { validTenantApp, tenantAppPaths, type AppAudience, type AppLocale } from "@/lib/tenant-pwa";
import { TenantAppInstall } from "@/components/tenant-app-install";

type Params = { locale: string; tenantSlug: string; audience: string };
function checked(params: Params): { tenantSlug: string; audience: AppAudience; locale: AppLocale } {
  if (
    (params.locale !== "hu" && params.locale !== "en") ||
    !validTenantApp(params.tenantSlug, params.audience)
  )
    notFound();
  return { ...params, locale: params.locale, audience: params.audience };
}
export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  const { locale, tenantSlug, audience } = checked(await params);
  return {
    title: `${tenantSlug} · ${audience === "staff" ? "Staff" : "Patients"}`,
    manifest: tenantAppPaths(tenantSlug, audience, locale).manifest,
    robots: { index: false, follow: false },
    appleWebApp: { capable: true, title: `${tenantSlug} · ${audience}`, statusBarStyle: "default" },
  };
}
export default async function InstallPage({ params }: { params: Promise<Params> }) {
  const { locale, tenantSlug, audience } = checked(await params);
  setRequestLocale(locale);
  return <TenantAppInstall tenantSlug={tenantSlug} audience={audience} locale={locale} />;
}
