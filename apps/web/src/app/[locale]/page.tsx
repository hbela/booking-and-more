import Image from "next/image";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { ADVERTISED_TRIAL_DAYS, PlanCards } from "@/components/plan-cards";
import { PublicFooter, PublicHeader } from "@/components/public-page";
import { Button } from "@/components/ui/button";
import { demoSiteUrl } from "@/lib/demo-site";
import { CalendarDays, ExternalLink, Users } from "lucide-react";

/**
 * The page a prospect reaches from the first email
 * (docs/customer-onboarding-and-website-links.md §2.1). It is written for
 * somebody who has no account yet: what the product does, the sample clinic
 * site, how to start, and the prices. Staff reach their workspace through
 * "Sign in" in the header, and install the app from their organization's own
 * `/{slug}/install/staff`, which the dashboard links.
 */
export default async function HomePage({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<React.ReactElement> {
  const { locale } = await params;
  setRequestLocale(locale);

  const t = await getTranslations("home");
  const legal = await getTranslations("legal");
  const demo = demoSiteUrl(locale);

  const steps = [
    { title: t("step1Title"), body: t("step1") },
    { title: t("step2Title"), body: t("step2", { days: ADVERTISED_TRIAL_DAYS }) },
    { title: t("step3Title"), body: t("step3") },
  ];

  return (
    <main className="flex min-h-screen flex-col">
      {/* The header sits on the page surface rather than over the hero: the
          controls inside it (a native select, a button, a link) are themed, and
          floating them on dark artwork would mean a second colour scheme for
          every one of them. */}
      <PublicHeader />

      {/* One image for both themes, deliberately: a browser can match
          `prefers-color-scheme` but not our `data-theme` cookie, so a per-theme
          <picture> would hand the dark art to somebody who chose light on a
          dark laptop (phase-11 §5.3). The artwork is dark and the scrim over it
          is fixed, so the light text on top holds its contrast either way. */}
      <header className="relative isolate overflow-hidden">
        <Image
          src="/hero-booking.jpg"
          alt=""
          width={1376}
          height={768}
          priority
          sizes="100vw"
          className="absolute inset-0 -z-10 h-full w-full object-cover"
        />
        <div className="absolute inset-0 -z-10 bg-slate-950/65" />

        <div className="mx-auto w-full max-w-5xl px-6 py-20">
          <h1 className="font-display max-w-3xl text-4xl font-bold tracking-tight text-white sm:text-5xl">
            {t("title")}
          </h1>
          <p className="mt-5 max-w-2xl text-lg leading-relaxed text-white/85">{t("description")}</p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Button asChild size="lg">
              <a href={demo}>
                {t("demoCta")}
                <ExternalLink size={16} aria-hidden="true" />
              </a>
            </Button>
            <Button asChild size="lg" variant="outline">
              <a href="#pricing-title">{t("pricingCta")}</a>
            </Button>
          </div>
        </div>
      </header>

      <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-12 px-4 py-12 sm:px-6">
        <div className="grid gap-6 md:grid-cols-2">
          <section
            aria-labelledby="patients-title"
            className="flex flex-col gap-4 rounded-xl border border-line p-6"
          >
            <CalendarDays size={28} className="text-primary" aria-hidden="true" />
            <h2 id="patients-title" className="font-display text-2xl font-bold">
              {t("patientsTitle")}
            </h2>
            <p className="leading-relaxed text-ink-muted">{t("patientsDescription")}</p>
          </section>
          <section
            aria-labelledby="team-title"
            className="flex flex-col gap-4 rounded-xl border border-line p-6"
          >
            <Users size={28} className="text-primary" aria-hidden="true" />
            <h2 id="team-title" className="font-display text-2xl font-bold">
              {t("teamTitle")}
            </h2>
            <p className="leading-relaxed text-ink-muted">{t("teamDescription")}</p>
          </section>
        </div>

        <section
          aria-labelledby="steps-title"
          className="flex flex-col gap-6 rounded-xl border border-line bg-surface-raised p-6 sm:p-8"
        >
          <h2 id="steps-title" className="font-display text-2xl font-bold">
            {t("stepsTitle")}
          </h2>
          <ol className="grid gap-6 md:grid-cols-3">
            {steps.map((step, index) => (
              <li key={step.title} className="flex flex-col gap-2">
                <span
                  aria-hidden="true"
                  className="flex size-9 items-center justify-center rounded-full bg-primary-surface font-semibold text-on-primary-surface"
                >
                  {index + 1}
                </span>
                <h3 className="font-semibold">{step.title}</h3>
                <p className="leading-relaxed text-ink-muted">{step.body}</p>
              </li>
            ))}
          </ol>
          <p className="text-sm leading-relaxed text-ink-muted">
            <a href={demo} className="font-medium text-primary underline underline-offset-4">
              {t("demoCta")}
            </a>{" "}
            · {t("demoNote")}
          </p>
        </section>

        <section aria-labelledby="pricing-title" className="flex scroll-mt-6 flex-col gap-6">
          <h2 id="pricing-title" className="font-display text-2xl font-bold">
            {legal("pricingTitle")}
          </h2>
          <PlanCards locale={locale} headingLevel={3} />
        </section>
      </div>
      <PublicFooter />
    </main>
  );
}
