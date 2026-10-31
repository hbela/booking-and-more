import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { PlanCards } from "@/components/plan-cards";
import { PublicFooter, PublicHeader } from "@/components/public-page";
import { Link } from "@/i18n/navigation";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "legal" });
  return { title: t("pricingTitle") };
}

export default async function PricingPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<React.ReactElement> {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("legal");

  return (
    <main className="flex min-h-screen flex-col">
      <PublicHeader />
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-8 px-4 py-12 sm:px-6">
        <div>
          <h1 className="font-display text-3xl font-bold tracking-tight sm:text-4xl">
            {t("pricingTitle")}
          </h1>
          <p className="text-ink-muted mt-3 max-w-2xl leading-relaxed">{t("pricingIntro")}</p>
        </div>
        <PlanCards locale={locale} />
        <p className="text-sm leading-relaxed">
          {t.rich("pricingTermsNote", {
            terms: (chunks) => (
              <Link href="/terms" className="underline underline-offset-4">
                {chunks}
              </Link>
            ),
            refund: (chunks) => (
              <Link href="/refund" className="underline underline-offset-4">
                {chunks}
              </Link>
            ),
          })}
        </p>
      </div>
      <PublicFooter />
    </main>
  );
}
