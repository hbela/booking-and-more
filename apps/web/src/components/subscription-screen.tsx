"use client";

import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { isLiveSubscription } from "@bam/contracts";
import { ApiError, apiFetch } from "@/lib/api-client";
import { DashboardShell, useDashboardContext, useSignInRedirect } from "./dashboard-shell";
import { NoOrganizationPanel } from "./no-organization";
import { Button, buttonRecipe } from "./ui/button";
import { Card } from "./ui/card";
import { ErrorText } from "./ui/field";

type Plan = "STARTER" | "PROFESSIONAL";

interface SubscriptionResponse {
  subscription: {
    plan: "INTERNAL" | Plan;
    status: string;
    currentPeriodEnd: string | null;
    cancelAtPeriodEnd: boolean;
    trialEndsAt: string | null;
    pendingPlan: "INTERNAL" | Plan | null;
    pendingPlanStartsAt: string | null;
  } | null;
  availablePlans: Plan[];
  portalAvailable: boolean;
  trialAvailable: boolean;
  trialPeriodDays: number;
}

/**
 * Where an owner starts their subscription.
 * docs/phase-9-subscription-and-activation.md §3.
 *
 * The screen never touches card details: it produces a Stripe payment link and
 * emails a copy. The email is the point rather than a nicety — it can be
 * forwarded to whoever holds the company card, who needs no account here (§1.1)
 * — but the link is shown too, so an owner sitting in front of the screen is
 * not blocked on mail delivery.
 */
export function SubscriptionScreen(): React.ReactElement {
  const t = useTranslations("dashboard");
  const context = useDashboardContext();
  useSignInRedirect(!context.isPending && !context.me);

  const [plan, setPlan] = useState<Plan>("STARTER");
  const [sent, setSent] = useState<{
    paymentUrl: string;
    emailedTo: string;
    trial: boolean;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const billing = useQuery({
    queryKey: ["billing", context.tenantId],
    queryFn: () =>
      apiFetch<SubscriptionResponse>("/v1/billing/subscription", {
        tenantId: context.tenantId,
      }),
    enabled: Boolean(context.tenantId),
  });

  /**
   * Into Stripe's customer portal — changing the card, invoices, cancelling.
   * docs/phase-9-customer-portal.md §5.
   *
   * A POST, and the URL is never rendered as a link: the session expires within
   * minutes and authenticates whoever holds it into the billing account, so it
   * is fetched at the moment of the click and consumed immediately (§1.1).
   * `assign` rather than a new tab for the same reason — a portal session in an
   * abandoned background tab has expired by the time anyone returns to it, and
   * Stripe sends the owner back to this screen anyway.
   */
  const portal = useMutation({
    mutationFn: () =>
      apiFetch<{ url: string }>("/v1/billing/portal", {
        method: "POST",
        tenantId: context.tenantId,
      }),
    onSuccess: (result) => {
      window.location.assign(result.url);
    },
    onError: (cause: unknown) => {
      setError(cause instanceof ApiError ? cause.message : t("genericError"));
    },
  });

  const subscribe = useMutation({
    mutationFn: () =>
      apiFetch<{ paymentUrl: string; emailedTo: string; trial: boolean }>("/v1/billing/subscribe", {
        method: "POST",
        tenantId: context.tenantId,
        body: { plan },
      }),
    onSuccess: (result) => {
      setSent(result);
    },
    onError: (cause: unknown) => {
      setError(cause instanceof ApiError ? cause.message : t("genericError"));
    },
  });

  if (context.isPending || !context.me) {
    return <p className="p-8">{t("loading")}</p>;
  }

  // Signed in, but there is no organization to scope this screen to. Every
  // query below is gated on `context.tenantId`, so without this the shell
  // renders around a body that never fills (see no-organization.tsx).
  if (context.hasNoOrganization) {
    return (
      <DashboardShell context={context}>
        <NoOrganizationPanel isPlatformAdmin={context.me.user.isPlatformAdmin} />
      </DashboardShell>
    );
  }

  const subscription = billing.data?.subscription;
  const availablePlans = billing.data?.availablePlans ?? [];
  // Not "is there a row" — the row outlives the subscription, so a cancelled
  // customer used to be told their subscription was active and everything was
  // unlocked, while the API happily let them subscribe again. One definition,
  // shared with the server (@bam/contracts).
  // The null check stays first so TypeScript still narrows `subscription` for
  // the branch below; the predicate answers the different question.
  const isSubscribed =
    subscription !== null && subscription !== undefined && isLiveSubscription(subscription.status);
  const isTrialing = subscription?.status === "TRIALING";

  return (
    <DashboardShell context={context}>
      <Card title={t("subscriptionTitle")}>
        {isSubscribed ? (
          <>
            <p role="status">{t("currentPlan", { plan: planLabel(subscription.plan, t) })}</p>

            {/* The trial's own countdown. Shown instead of the renewal date,
                not alongside it: during a trial "renews on" would be the first
                *charge*, and calling that a renewal is how a customer ends up
                surprised by a bill they were told about in the wrong words. */}
            {isTrialing && subscription.trialEndsAt ? (
              <p className="text-sm text-ink-muted">
                {t("trialEndsOn", {
                  date: new Date(subscription.trialEndsAt).toLocaleDateString(),
                  plan: planLabel(subscription.plan, t),
                })}
              </p>
            ) : subscription.currentPeriodEnd ? (
              <p className="text-sm text-ink-muted">
                {subscription.cancelAtPeriodEnd
                  ? t("cancelsOn", {
                      date: new Date(subscription.currentPeriodEnd).toLocaleDateString(),
                    })
                  : t("renewsOn", {
                      date: new Date(subscription.currentPeriodEnd).toLocaleDateString(),
                    })}
              </p>
            ) : null}

            {/* A downgrade the owner scheduled. Without this the screen shows
                the plan they are leaving and no sign that they left it, which
                is the support ticket §2.4 exists to prevent. */}
            {subscription.pendingPlan && subscription.pendingPlanStartsAt ? (
              <p role="status" className="text-sm text-ink-muted">
                {t("planChangesOn", {
                  plan: planLabel(subscription.pendingPlan, t),
                  date: new Date(subscription.pendingPlanStartsAt).toLocaleDateString(),
                })}
              </p>
            ) : null}

            {/* Access continues while Stripe retries — saying otherwise would
                be false — but the deadline has to be named or it gets ignored
                until the organization is suspended (§2.3). */}
            {subscription.status === "PAST_DUE" ? (
              <p role="alert" className="text-sm text-warning">
                {t("paymentFailedNotice")}
              </p>
            ) : null}

            <p className="text-sm text-ink-muted">
              {subscription.cancelAtPeriodEnd
                ? t("subscriptionEnding")
                : isTrialing
                  ? t("trialActive")
                  : t("subscriptionActive")}
            </p>

            <ErrorText>{error}</ErrorText>

            {/* Absent rather than broken when Stripe is unconfigured — the same
                rule that decides which plans are offered. */}
            {billing.data?.portalAvailable ? (
              <Button
                disabled={portal.isPending}
                onClick={() => {
                  setError(null);
                  portal.mutate();
                }}
              >
                {portal.isPending ? t("loading") : t("manageBilling")}
              </Button>
            ) : null}

            {billing.data?.portalAvailable ? (
              <p className="text-sm text-ink-muted">{t("manageBillingHint")}</p>
            ) : null}
          </>
        ) : availablePlans.length === 0 ? (
          // Billing is unconfigured. Saying so beats a button that leads to a
          // blank Stripe page (rule 4: one feature degrades, nothing crashes).
          <ErrorText>{t("noPlansConfigured")}</ErrorText>
        ) : sent ? (
          <>
            <p role="status">{t("paymentLinkSent", { email: sent.emailedTo })}</p>
            {/* A real <a>, not ButtonLink: this leaves the app for Stripe's
                hosted page, so it must not go through the locale-aware router.
                The recipe gives it the button's styling without its element. */}
            <a
              href={sent.paymentUrl}
              target="_blank"
              rel="noreferrer noopener"
              className={buttonRecipe()}
            >
              {sent.trial ? t("goToTrial") : t("goToPayment")}
            </a>
          </>
        ) : (
          <form
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              setError(null);
              subscribe.mutate();
            }}
          >
            {/* Only when there is actually a trial to have. The server decides
                — a Payment Link's trial is baked into the link, so promising
                one the link does not carry would be a promise Stripe breaks at
                the checkout page (§2.1). */}
            {billing.data?.trialAvailable ? (
              <p className="text-sm text-ink-muted">
                {t("trialOffer", { days: billing.data.trialPeriodDays })}
              </p>
            ) : (
              <p className="text-sm text-ink-muted">{t("trialAlreadyUsed")}</p>
            )}

            <fieldset className="flex flex-col gap-2">
              <legend className="text-sm font-medium">{t("choosePlan")}</legend>

              {availablePlans.map((option) => (
                <label key={option} className="flex items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name="plan"
                    value={option}
                    checked={plan === option}
                    onChange={() => {
                      setPlan(option);
                    }}
                  />
                  <span>{planLabel(option, t)}</span>
                </label>
              ))}
            </fieldset>

            <ErrorText>{error}</ErrorText>

            <Button type="submit" disabled={subscribe.isPending}>
              {subscribe.isPending
                ? t("loading")
                : billing.data?.trialAvailable
                  ? t("startTrial")
                  : t("sendPaymentLink")}
            </Button>
          </form>
        )}
      </Card>
    </DashboardShell>
  );
}

/** INTERNAL has no marketing name; it is shown as-is to the few who see it. */
function planLabel(plan: string, t: (key: string) => string): string {
  if (plan === "STARTER") return t("planStarter");
  if (plan === "PROFESSIONAL") return t("planProfessional");
  return plan;
}
