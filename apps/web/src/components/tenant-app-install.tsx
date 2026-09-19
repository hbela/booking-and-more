"use client";

import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { apiFetch } from "@/lib/api-client";
import { tenantAppPaths, type AppAudience, type AppLocale } from "@/lib/tenant-pwa";
import { Brand } from "./brand";
import { InstallApp } from "./staff-pwa";
import { buttonRecipe } from "./ui/button";
import { LocaleSwitcher } from "./locale-switcher";

export function TenantAppInstall({
  tenantSlug,
  audience,
  locale,
}: {
  tenantSlug: string;
  audience: AppAudience;
  locale: AppLocale;
}) {
  const t = useTranslations("tenantApp");
  const pwa = useTranslations("pwa");
  const common = useTranslations("common");
  const tenant = useQuery({
    queryKey: ["public-tenant", tenantSlug],
    queryFn: () => apiFetch<{ name: string; slug: string }>(`/v1/public/tenants/${tenantSlug}`),
    retry: false,
  });
  return (
    <main className="mx-auto flex min-h-screen max-w-[720px] flex-col gap-8 px-4 py-6 sm:px-6 sm:py-10">
      <header className="flex flex-wrap items-center justify-between gap-4 border-b border-line pb-6">
        <Brand />
        <LocaleSwitcher label={common("language")} />
      </header>
      {tenant.isPending ? (
        <p role="status">{common("loading")}</p>
      ) : tenant.isError ? (
        <div role="alert">
          <h1 className="font-display text-2xl font-bold">{t("unavailable")}</h1>
          <p className="mt-3">{t("tryLater")}</p>
        </div>
      ) : (
        <section className="flex flex-col gap-6 rounded-xl border border-line p-6 sm:p-8">
          <div>
            <p className="font-medium text-primary">{tenant.data.name}</p>
            <h1 className="mt-2 font-display text-3xl font-bold">
              {t(audience === "staff" ? "staffTitle" : "patientTitle")}
            </h1>
          </div>
          <p className="leading-relaxed text-ink-muted">
            {t(audience === "staff" ? "staffDescription" : "patientDescription")}
          </p>
          <InstallApp />
          <p className="text-sm leading-relaxed text-ink-muted">{t("confirmation")}</p>
          <div className="rounded-xl bg-surface-raised p-4">
            <h2 className="font-semibold">Android · Chrome</h2>
            <p className="mt-2 leading-relaxed">{pwa("androidHelp")}</p>
          </div>
          <div className="rounded-xl bg-surface-raised p-4">
            <h2 className="font-semibold">iPhone / iPad · Safari</h2>
            <p className="mt-2 leading-relaxed">{pwa("iosHelp")}</p>
          </div>
          {/* Full navigation avoids carrying an install prompt from a different manifest. */}
          <a
            href={tenantAppPaths(tenantSlug, audience, locale).launch}
            className={buttonRecipe({ variant: "secondary" })}
          >
            {t("continue")}
          </a>
          <p className="text-sm text-ink-muted">{t("online")}</p>
        </section>
      )}
    </main>
  );
}
