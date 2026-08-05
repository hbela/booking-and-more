import { z } from "zod";

/**
 * Vocabulary shared by billing, the platform dashboard and the owner's
 * subscription screen. docs/phase-9-subscription-and-activation.md.
 */

/**
 * The plans a customer can actually buy.
 *
 * `INTERNAL` is deliberately absent. It exists so that every ACTIVE tenant has
 * a subscription row and quota enforcement never meets a missing plan
 * (phase-9 §2.2) — it is not sold, has no price, and offering it on a screen
 * would be offering the product for free.
 */
export const subscribablePlanSchema = z.enum(["STARTER", "PROFESSIONAL"]);

export type SubscribablePlan = z.infer<typeof subscribablePlanSchema>;

/**
 * Whole days between now and a deadline, floored, never negative.
 *
 * Two behaviours matter and both are deliberate:
 *
 *  - **Null in, null out.** A null deadline is not "zero days left" — it is an
 *    organization with no deadline at all, which is what an internal or demo
 *    tenant is (phase-9 §2.2). Callers render nothing rather than a countdown,
 *    and that distinction falling out of the model is why there is no special
 *    case for demo tenants anywhere else.
 *  - **Floored at zero.** An overdue organization reads as 0 days, not as -3.
 *    The sweep decides what happens to it; a screen counting downwards past
 *    zero only ever confuses.
 *
 * `now` is a parameter rather than a call to the clock so this stays pure and
 * testable, matching the engines' convention.
 */
export function daysUntil(
  deadline: Date | null | undefined,
  now: Date = new Date(),
): number | null {
  if (deadline === null || deadline === undefined) return null;

  const remaining = deadline.getTime() - now.getTime();

  return Math.max(0, Math.floor(remaining / (24 * 60 * 60 * 1_000)));
}

// ---------------------------------------------------------------------------
// Which plan is this?
// docs/phase-9-subscription-lifecycle.md §2.4
// ---------------------------------------------------------------------------

/** Stripe price ID → plan. Configured, because Stripe cannot tell us. */
export type PlanPrices = Partial<Record<SubscribablePlan, string>>;

/**
 * Resolve a plan from a Stripe price ID.
 *
 * Replaces reading `metadata.plan`, which the customer-portal record §3.2
 * already flagged as a load-bearing Stripe setup step. Scheduled downgrades
 * made it untenable rather than merely fragile: a subscription **schedule**
 * phase carries `items[0].price` as a bare price-ID string, with no metadata on
 * it at all, so there is nothing for the old approach to read.
 *
 * Returns undefined rather than guessing. Every caller has its own right answer
 * for "unknown" — activation falls back to STARTER because a customer who has
 * paid must end up active, an update leaves the existing plan alone — and
 * choosing here would take that decision away from them.
 */
export function planForPrice(
  priceId: string | undefined,
  prices: PlanPrices,
): SubscribablePlan | undefined {
  if (priceId === undefined || priceId === "") return undefined;

  for (const [plan, configured] of Object.entries(prices) as [SubscribablePlan, string][]) {
    if (configured === priceId) return plan;
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// What does Stripe's state mean for access?
// docs/phase-9-subscription-lifecycle.md §3
// ---------------------------------------------------------------------------

/** Our mirror of Stripe's status. Matches the `SubscriptionStatus` enum. */
export type MirroredSubscriptionStatus =
  "ACTIVE" | "PAST_DUE" | "CANCELED" | "INCOMPLETE" | "TRIALING" | "NOT_APPLICABLE";

/**
 * Statuses that mean the organization *has* a subscription right now.
 *
 * A `Subscription` row outlives the subscription it describes — cancellation
 * sets the status to `CANCELED` and keeps the row, which is what makes
 * `trialUsedAt` able to stop a second free trial (§5). So "is there a row" and
 * "is there a subscription" are different questions, and answering the second
 * with the first is how a cancelled customer gets told their subscription is
 * active.
 *
 * `NOT_APPLICABLE` counts: it is the INTERNAL plan, which has no Stripe
 * counterpart but is very much a live entitlement.
 */
const LIVE_SUBSCRIPTION_STATUSES = new Set<string>([
  "ACTIVE",
  "TRIALING",
  "PAST_DUE",
  "NOT_APPLICABLE",
]);

/**
 * Does this organization currently hold a subscription?
 *
 * One definition, used by the API to refuse a duplicate checkout and by the
 * screen to decide whether to offer plans or show the current one. They were
 * two copies of the same idea and disagreed: the screen counted any row, so a
 * cancelled customer was told "your subscription is active — everything is
 * unlocked" while the API correctly let them subscribe again.
 */
export function isLiveSubscription(status: string | null | undefined): boolean {
  return status !== null && status !== undefined && LIVE_SUBSCRIPTION_STATUSES.has(status);
}

/** What a tenant becomes. `null` means "leave it exactly as it is". */
export type TenantStatusEffect = "TRIAL" | "ACTIVE" | "SUSPENDED" | null;

export interface SubscriptionEffect {
  status: MirroredSubscriptionStatus;
  tenantStatus: TenantStatusEffect;
}

/**
 * The entire entitlement rule, in one table.
 *
 * It lives here — pure, in contracts, next to the rest of the billing
 * vocabulary — because it used to be three fragments spread across `activate`,
 * `mirrorSubscription` and `suspend` in the worker, each deciding part of it.
 * That is exactly the shape that drifts (CLAUDE.md rule 8: decisions belong in
 * pure functions, not in the code that happens to receive the event).
 *
 * Two rules constrain every row, and both are refusals worth keeping:
 *
 *  - **Nothing here ever lifts a tenant out of SUSPENDED.** `null` for
 *    `past_due` and `incomplete` is what enforces it. SUSPENDED has two causes
 *    — Stripe cancelled, or a platform admin intervened — and the tenant row
 *    does not record which, so reactivating on a Stripe event would silently
 *    reverse an operator's suspension of an organization under investigation
 *    (customer-portal §3.3). Recovery is deliberate and stays manual.
 *
 *  - **`past_due` keeps access.** Stripe's own dunning is the grace period
 *    (§2.3): Smart Retries gives up after a configured window and cancels,
 *    which arrives as `customer.subscription.deleted` and suspends through the
 *    row below. A `pastDueSince` column and a sweep would be a second, slower
 *    copy of a mechanism Stripe already runs.
 *
 * Throws on anything unrecognised, per phase-9 §2.7 — the predecessor stored
 * Stripe's status as free text and a value nobody had considered simply sat in
 * the column being wrong.
 */
export function subscriptionEffect(stripeStatus: string): SubscriptionEffect {
  switch (stripeStatus) {
    case "trialing":
      return { status: "TRIALING", tenantStatus: "TRIAL" };

    case "active":
      return { status: "ACTIVE", tenantStatus: "ACTIVE" };

    // Access continues. Stripe is still retrying, and it is what decides when
    // to stop — see the note above.
    case "past_due":
      return { status: "PAST_DUE", tenantStatus: null };

    // Retries exhausted. Distinct from `past_due` in Stripe's model and in
    // ours: this one is the end of the road.
    case "unpaid":
      return { status: "PAST_DUE", tenantStatus: "SUSPENDED" };

    case "canceled":
      return { status: "CANCELED", tenantStatus: "SUSPENDED" };

    // The first payment has not completed. Nothing to grant, nothing to revoke
    // — a tenant here is still PENDING_SUBSCRIPTION and already writes nothing.
    case "incomplete":
      return { status: "INCOMPLETE", tenantStatus: null };

    case "incomplete_expired":
      return { status: "INCOMPLETE", tenantStatus: "SUSPENDED" };

    // A trial that ended with no payment method, when the link is configured to
    // pause rather than cancel. Reachable only by misconfiguration — our links
    // collect the card upfront (§6) — but it means "no access" either way.
    case "paused":
      return { status: "PAST_DUE", tenantStatus: "SUSPENDED" };

    default:
      throw new Error(`Unrecognised Stripe subscription status: ${stripeStatus}`);
  }
}

/**
 * What a tenant's status should actually become, given where it is now.
 *
 * `subscriptionEffect` says what Stripe implies; this says what we allow. The
 * two are separate because the second is a *refusal*, and burying a refusal
 * inside a mapping table is how it gets edited away by somebody adding a row.
 *
 * The rule, in one sentence: **a Stripe event may suspend an organization but
 * never revive one.** Returning null means "leave it alone".
 *
 * SUSPENDED has two causes — Stripe cancelled the subscription, or a platform
 * admin used `PATCH /v1/platform/organizations/:id/status` — and the tenant row
 * does not record which. Without this guard, an organization suspended for
 * abuse or non-payment by transfer would be silently reactivated the moment any
 * subscription event reported `active`, including a redelivery of an event from
 * before the suspension (customer-portal §3.3).
 *
 * CLOSED is likewise terminal here: reopening a closed prospect is a deliberate
 * platform-admin action (phase-9 §2.6.1), not something a webhook does.
 */
export function nextTenantStatus(current: string, effect: TenantStatusEffect): TenantStatusEffect {
  if (effect === null) return null;

  // Suspension always applies. A subscription that ended is a fact about the
  // organization whatever state it was in.
  if (effect === "SUSPENDED") return current === "SUSPENDED" ? null : "SUSPENDED";

  // Everything else is a revival, and is refused from a terminal state.
  if (current === "SUSPENDED" || current === "CLOSED") return null;

  return current === effect ? null : effect;
}

/**
 * What an organization goes back to when a platform admin lifts a suspension.
 *
 * The counterpart to {@link nextTenantStatus}: that one refuses to revive a
 * suspended organization from a Stripe event, which leaves exactly one way back
 * — a deliberate act by an operator. This decides where that act lands.
 *
 * Not `ACTIVE`, which is what suspending and reactivating used to produce
 * whatever the organization had been. Two ways that was wrong:
 *
 *  - A **trialling** organization came back `ACTIVE` while its subscription row
 *    still said `TRIALING`, so the two disagreed about the same customer.
 *  - A **prospect** that had never paid came back `ACTIVE` with no subscription
 *    row at all — precisely the state phase-9 §2.2 forbids, and the reason the
 *    demo seed was deleted.
 *
 * Derived from the subscription rather than remembered, because the tenant row
 * does not record what it was before it was suspended, and a subscription can
 * legitimately have expired *during* the suspension — the entitlement now is
 * the honest answer, not the one from before.
 *
 * `isLiveSubscription` is reused rather than restated so this cannot drift from
 * the definition the rest of billing uses; `PAST_DUE` therefore restores access,
 * for the same reason it keeps it (§2.3: Stripe's dunning is the grace period).
 */
export function restoredTenantStatus(
  subscriptionStatus: string | null | undefined,
): "TRIAL" | "ACTIVE" | "PENDING_SUBSCRIPTION" {
  // No live entitlement — including no row at all — means they are back to
  // needing one, not back to being a customer.
  if (!isLiveSubscription(subscriptionStatus)) return "PENDING_SUBSCRIPTION";

  return subscriptionStatus === "TRIALING" ? "TRIAL" : "ACTIVE";
}
