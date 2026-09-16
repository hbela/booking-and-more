import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { normalizeDomain, slugSchema } from "@bam/contracts";
import { routing } from "@/i18n/routing";
import { TenantSignIn } from "@/components/tenant-sign-in";
import { AuthLayout } from "@/components/ui/auth-layout";

export default async function TenantSignInPage({
  params,
}: {
  params: Promise<{ locale: string; tenantSlug: string }>;
}): Promise<React.ReactElement> {
  const { locale, tenantSlug } = await params;
  // Only a bare domain is allowed in this path, never a URL, port or email.
  const isDomain = /^[a-z0-9.-]+$/i.test(tenantSlug) && normalizeDomain(tenantSlug) !== undefined;
  if (
    !(routing.locales as readonly string[]).includes(locale) ||
    (!slugSchema.safeParse(tenantSlug).success && !isDomain)
  )
    notFound();
  setRequestLocale(locale);
  const t = await getTranslations("tenantLogin");
  return (
    <AuthLayout title={t("title", { tenant: tenantSlug })}>
      <p className="text-sm text-ink-muted">{t("intro")}</p>
      <TenantSignIn key={tenantSlug} tenantSlug={tenantSlug} />
    </AuthLayout>
  );
}
