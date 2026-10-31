import { SUBSCRIPTION_OFFERS, type SubscribablePlan } from "@bam/contracts";
import { getTranslations } from "next-intl/server";
import { Button } from "@/components/ui/button";
import { Link } from "@/i18n/navigation";

/**
 * Advertised trial length. The server's `TRIAL_PERIOD_DAYS` (default 30) is
 * what a Payment Link actually carries; this copy has to agree with it, and the
 * web app cannot read the API's configuration.
 */
const ADVERTISED_TRIAL_DAYS = 30;

const PLANS: readonly SubscribablePlan[] = ["STARTER", "PROFESSIONAL", "PROFESSIONAL_PLUS"];

/**
 * The three plans, priced from `SUBSCRIPTION_OFFERS` — the same source the
 * subscription screen uses, so the public price and the one an owner is shown
 * when subscribing cannot drift apart. Names and descriptions reuse the
 * subscription screen's copy for the same reason.
 */
export async function PlanCards({
  locale,
  headingLevel = 2,
}: {
  locale: string;
  headingLevel?: 2 | 3;
}): Promise<React.ReactElement> {
  const t = await getTranslations("legal");
  const plans = await getTranslations("dashboard");
  const Heading = headingLevel === 2 ? "h2" : "h3";

  const name: Record<SubscribablePlan, string> = {
    STARTER: plans("planStarter"),
    PROFESSIONAL: plans("planProfessional"),
    PROFESSIONAL_PLUS: plans("planProfessionalPlus"),
  };
  const description: Record<SubscribablePlan, string> = {
    STARTER: plans("planStarterDescription"),
    PROFESSIONAL: plans("planProfessionalDescription"),
    PROFESSIONAL_PLUS: plans("planProfessionalPlusDescription"),
  };

  return (
    <div className="flex flex-col gap-6">
      <ul className="grid gap-4 md:grid-cols-3">
        {PLANS.map((plan) => {
          const offer = SUBSCRIPTION_OFFERS[plan];
          const price = new Intl.NumberFormat(locale, {
            style: "currency",
            currency: offer.currency,
            maximumFractionDigits: 0,
          }).format(offer.monthlyAmount);
          return (
            <li key={plan} className="border-line flex flex-col gap-3 rounded-xl border p-6">
              <Heading className="font-display text-xl font-bold">{name[plan]}</Heading>
              <p>
                <span className="font-display text-3xl font-bold">{price}</span>{" "}
                <span className="text-ink-muted">{plans("perMonth")}</span>
              </p>
              <p className="text-ink-muted leading-relaxed">{description[plan]}</p>
              <Button asChild className="mt-auto">
                <Link href="/sign-up">{t("startTrial")}</Link>
              </Button>
            </li>
          );
        })}
      </ul>
      <ul className="text-ink-muted flex flex-col gap-2 text-sm leading-relaxed">
        <li>{plans("trialOffer", { days: ADVERTISED_TRIAL_DAYS })}</li>
        <li>{plans("pricesTaxExempt")}</li>
        <li>{t("billingNote")}</li>
        <li>{plans("assistedSetupOffer")}</li>
      </ul>
    </div>
  );
}
