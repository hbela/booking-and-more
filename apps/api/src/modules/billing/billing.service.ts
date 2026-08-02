import type { PrismaClient } from "@bam/db";
import {
  AppError,
  ConflictError,
  ErrorCodes,
  isLiveSubscription,
  NotFoundError,
  ServiceUnavailableError,
  type SubscribablePlan,
} from "@bam/contracts";

import type { PaymentLinkClient, PortalSessionCreator } from "./stripe.client.js";

/**
 * Selling a subscription. docs/phase-9-subscription-and-activation.md §3, as
 * rewritten by docs/phase-9-duplicate-subscription-prevention.md §4.
 *
 * ## The thing to understand before changing anything here
 *
 * One organization once reached **three live Stripe subscriptions**. The guard
 * that should have stopped it read the local `subscriptions` row — which is
 * written by the worker when `checkout.session.completed` is processed. It
 * asked the payment path whether the payment path had finished, and got "no"
 * for as long as the webhook was late. Any delivery delay reopened it.
 *
 * It was also, on its own, unfixable: the Payment Link used to be a permanent
 * URL shared by every customer on a plan, sitting in the owner's inbox forever.
 * This service vends links; it is not on the path between their browser and
 * Stripe's hosted page. Refusing to vend a second one does nothing about the
 * first (§2.2).
 *
 * So there are now three guards, none of which depends on the webhook:
 *
 *  1. **One link row per organization**, `@unique` on `tenantId`. PostgreSQL
 *     decides the double-click, not a read-then-write here (rule 14). A second
 *     request gets the first request's link back, never a new one.
 *  2. **`completed_sessions.limit = 1` on the link itself**, enforced by Stripe
 *     at checkout — the only guard standing on the path we cannot reach.
 *  3. **`checkout.sessions.list` before re-issuing**, which is a list rather
 *     than a search and therefore strongly consistent. This is the authoritative
 *     "have they already paid?" that the old row-read was pretending to be.
 *
 * Remove any one and the other two still hold. Remove the reasoning and
 * somebody will restore the single read-then-write, because it looks simpler.
 */

export type PlanPriceIds = Partial<Record<SubscribablePlan, string>>;

export interface BillingServiceOptions {
  /**
   * Stripe price ID per sellable plan; a plan absent here is not sold. Links are
   * built from a price now rather than held in config as URLs — which is what
   * let the trial/no-trial link pair go away (§4.2), since
   * `subscription_data.trial_period_days` is settable per organization on a
   * link created per organization.
   */
  planPrices: PlanPriceIds;
  /** What a first-time organization is given. Stripe is told this number. */
  trialPeriodDays: number;
  /**
   * Absent when Stripe is unconfigured. Selling then degrades to 503 rather
   * than crashing (rule 4), exactly as the portal already does.
   */
  paymentLinkClient?: PaymentLinkClient | undefined;
  /**
   * Absent when Stripe is unconfigured, which is what turns the portal into a
   * 503 with no `if (env…)` down here (docs/phase-9-customer-portal.md §2.2).
   * Injected rather than imported so the calls this service makes to a third
   * party can be asserted without a network round trip in the suite.
   */
  createPortalSession?: PortalSessionCreator | undefined;
  /** Where Stripe sends the owner back to. */
  portalReturnUrl?: string | undefined;
}

export class BillingService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly options: BillingServiceOptions,
  ) {}

  /**
   * Which plans can actually be bought right now.
   *
   * Empty when Stripe is unconfigured, because a link cannot be created without
   * it. That is a stronger condition than before — the links used to be static
   * config and could be offered with no secret key — and it is the honest one:
   * a plan we cannot build a link for is a plan that leads nowhere.
   */
  availablePlans(): SubscribablePlan[] {
    if (this.options.paymentLinkClient === undefined) return [];

    return (Object.keys(this.options.planPrices) as SubscribablePlan[]).filter(
      (plan) => this.options.planPrices[plan] !== undefined,
    );
  }

  /** Whether the screen should offer "manage billing" at all. */
  portalAvailable(): boolean {
    return this.options.createPortalSession !== undefined;
  }

  async currentSubscription(tenantId: string) {
    return this.prisma.subscription.findUnique({
      where: { tenantId },
      select: {
        plan: true,
        status: true,
        currentPeriodEnd: true,
        cancelAtPeriodEnd: true,
        trialEndsAt: true,
        trialUsedAt: true,
        pendingPlan: true,
        pendingPlanStartsAt: true,
      },
    });
  }

  /**
   * A short-lived URL into Stripe's customer portal, for an owner to change
   * their card, read invoices or cancel.
   * docs/phase-9-customer-portal.md §2.
   *
   * Nothing about the session is stored or logged. It expires within minutes
   * and authenticates whoever holds it into the customer's billing account, so
   * the only correct thing to do with it is hand it to the browser that asked
   * (§1.1) — which is also why this is never emailed, though the payment link
   * is.
   */
  async portalSession(tenantId: string): Promise<{ url: string }> {
    const subscription = await this.prisma.subscription.findUnique({
      where: { tenantId },
      select: { stripeCustomerId: true },
    });

    const customerId = subscription?.stripeCustomerId ?? null;

    // Checked before Stripe's configuration, deliberately. Both answers are
    // true when both faults hold, and the caller's own state is the more
    // specific of the two: "you have never paid through Stripe" holds whatever
    // we have configured, whereas the 503 below is a fact about us.
    //
    // No customer id means nothing was ever bought through Stripe — an
    // organization on INTERNAL, or one activated by hand. There is no billing
    // account to manage, which is a conflict with the request rather than a
    // failure of ours.
    if (customerId === null) {
      throw new ConflictError(
        ErrorCodes.VALIDATION_FAILED,
        "This organization has no subscription to manage yet.",
      );
    }

    const create = this.options.createPortalSession;

    if (create === undefined || this.options.portalReturnUrl === undefined) {
      throw new ServiceUnavailableError(
        "Billing management is not available right now. Please contact us.",
      );
    }

    try {
      return await create({ customerId, returnUrl: this.options.portalReturnUrl });
    } catch (cause) {
      // Overwhelmingly the missing portal configuration in the Stripe
      // dashboard (§2.1). A setup step should not read as a 500 and page
      // somebody.
      //
      // The cause travels as `cause` rather than as `details`: details are
      // serialized into the response envelope, and Stripe's message names
      // internal identifiers the owner has no business seeing. As a 5xx this
      // is reported, so the real reason reaches the logs either way.
      throw new AppError(
        ErrorCodes.SERVICE_UNAVAILABLE,
        "Billing management is not available right now. Please contact us.",
        { statusCode: 503, cause },
      );
    }
  }

  /**
   * Build the payment link for this tenant, and record that it should be
   * emailed.
   *
   * The email is *requested*, not sent (tech-impl §12). Sending it here would
   * put a third-party HTTP call inside a request that also has to answer the
   * browser — the predecessor did exactly that and swallowed the failure, so an
   * owner who never received their link looked identical to one who did.
   *
   * Which of the plan's two links is sent depends on whether this organization
   * has had its free trial (docs/phase-9-subscription-lifecycle.md §2.1).
   */
  async requestPaymentLink(input: {
    tenantId: string;
    plan: SubscribablePlan;
    recipientEmail: string;
    recipientName: string | null;
  }): Promise<{ paymentUrl: string; emailedTo: string; trial: boolean }> {
    const priceId = this.options.planPrices[input.plan];

    if (priceId === undefined) {
      throw new NotFoundError(
        `The ${input.plan} plan is not available. Please contact us.`,
        ErrorCodes.VALIDATION_FAILED,
      );
    }

    const links = this.options.paymentLinkClient;

    if (links === undefined) {
      throw new ServiceUnavailableError(
        "Subscribing is not available right now. Please contact us.",
      );
    }

    // Read directly rather than through `currentSubscription`, which serves the
    // screen and must not start returning Stripe identifiers to do so.
    const existing = await this.prisma.subscription.findUnique({
      where: { tenantId: input.tenantId },
      select: { status: true, trialUsedAt: true, stripeSubscriptionId: true },
    });

    // The cheap local guard. It is no longer the only one, and it is no longer
    // trusted to be timely — it exists so the common case costs nothing.
    //
    // Widened beyond `isLiveSubscription` deliberately (§5.4): `activate()`
    // writes the row as INCOMPLETE, which is *not* live, so a status test alone
    // stayed open until `customer.subscription.created` had also been processed
    // — a second event and a second poll interval. Any Stripe subscription id
    // at all means a checkout completed, whatever we have mirrored since.
    //
    // A CANCELED row keeps its id, so a returning customer would be refused
    // here; `cancelAtPeriodEnd`-style states are why the status is checked too
    // rather than instead. Resubscribing after cancellation goes through the
    // portal, which is where the customer already is.
    if (isLiveSubscription(existing?.status) || existing?.stripeSubscriptionId != null) {
      throw new ConflictError(
        ErrorCodes.VALIDATION_FAILED,
        "This organization already has a subscription.",
      );
    }

    const tenant = await this.prisma.tenant.findUnique({
      where: { id: input.tenantId },
      select: { id: true, name: true },
    });

    if (!tenant) throw new NotFoundError("That organization does not exist.");

    // The trial-once gate. `trialUsedAt` is on the subscription row precisely
    // because that row outlives a cancellation, so this is the path a returning
    // customer takes: the stamp is what stops them collecting another thirty
    // free days. It now decides whether Stripe is told `trial_period_days` at
    // all, rather than which of two configured URLs to send.
    const trial = existing?.trialUsedAt == null;

    const link = await this.checkoutLinkFor({
      tenantId: input.tenantId,
      plan: input.plan,
      priceId,
      trial,
      links,
    });

    await this.prisma.outboxEvent.create({
      data: {
        tenantId: input.tenantId,
        eventType: "SUBSCRIPTION_LINK_REQUESTED",
        aggregateType: "Tenant",
        aggregateId: input.tenantId,
        payload: {
          recipientEmail: input.recipientEmail,
          recipientName: input.recipientName,
          organizationName: tenant.name,
          plan: input.plan,
          paymentUrl: link.url,
          // So the email can say "start your free trial" or "resume your
          // subscription" — the same link with two very different meanings.
          trial: link.trial,
        },
      },
    });

    // `link.trial`, not `trial`: a second request for an existing link reports
    // what that link was actually created with. They agree unless the trial was
    // used between the two requests, and in that case the link in the
    // customer's hand is the truth.
    return { paymentUrl: link.url, emailedTo: input.recipientEmail, trial: link.trial };
  }

  /**
   * The organization's one checkout link — reused if it has one, created if not.
   *
   * Never mints a second link for a tenant that already has an unused one. That
   * is the point: a per-link limit of one completed session is worth nothing if
   * a double-clicked button produces two links, each with its own allowance.
   */
  private async checkoutLinkFor(input: {
    tenantId: string;
    plan: SubscribablePlan;
    priceId: string;
    trial: boolean;
    links: PaymentLinkClient;
  }): Promise<{ url: string; trial: boolean }> {
    const existing = await this.prisma.subscriptionCheckoutLink.findUnique({
      where: { tenantId: input.tenantId },
    });

    if (existing !== null) {
      // Ask Stripe, not ourselves. This is the guard that does not depend on
      // the webhook: `checkout.sessions.list` is a list filtered on
      // `payment_link` and `status`, read straight through, with none of the
      // "up to an hour behind" caveat that disqualifies `subscriptions.search`
      // (§3.1). If they have paid, this says so whether or not a single Stripe
      // event has reached us.
      if (existing.consumedAt !== null || (await input.links.hasCompletedCheckout(existing.stripePaymentLinkId))) {
        // Record what we just learned, so the next request can answer for free
        // and so an operator reading the row is not misled by a null.
        if (existing.consumedAt === null) {
          await this.prisma.subscriptionCheckoutLink.update({
            where: { tenantId: input.tenantId },
            data: { consumedAt: new Date() },
          });
        }

        throw new ConflictError(
          ErrorCodes.VALIDATION_FAILED,
          "This organization has already paid. Its subscription is being activated — this usually takes a moment.",
        );
      }

      // Unused, same plan: hand back the identical URL. A rebuilt one that
      // merely looks the same would be a second link as far as Stripe is
      // concerned, with a second allowance.
      if (existing.plan === input.plan) {
        return { url: existing.url, trial: existing.trial };
      }

      // The owner changed their mind before paying. Stop the old link being
      // buyable *before* creating the new one — the other order leaves both
      // live, and both usable, for as long as the create takes.
      await input.links.deactivate(existing.stripePaymentLinkId);
      await this.prisma.subscriptionCheckoutLink.delete({ where: { tenantId: input.tenantId } });
    }

    const created = await input.links.create({
      priceId: input.priceId,
      tenantId: input.tenantId,
      plan: input.plan,
      trialPeriodDays: input.trial ? this.options.trialPeriodDays : null,
    });

    const url = buildPaymentUrl(created.url, input.tenantId);

    try {
      await this.prisma.subscriptionCheckoutLink.create({
        data: {
          tenantId: input.tenantId,
          plan: input.plan,
          trial: input.trial,
          stripePaymentLinkId: created.id,
          url,
        },
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;

      // Two requests raced and this one lost. The database decided, exactly as
      // rule 14 intends — and the loser's job is to translate that, not to
      // retry. The winner's link is the organization's link.
      //
      // The link this call created in Stripe is now orphaned, so it is
      // deactivated rather than left buyable. Failing to do so would leave the
      // tenant with two live links, which is the whole thing being prevented.
      await input.links.deactivate(created.id).catch(() => undefined);

      const winner = await this.prisma.subscriptionCheckoutLink.findUnique({
        where: { tenantId: input.tenantId },
      });

      if (winner === null) throw error;

      return { url: winner.url, trial: winner.trial };
    }

    return { url, trial: input.trial };
  }
}

/**
 * `client_reference_id` is the entire join key.
 *
 * Stripe echoes it back on `checkout.session.completed`, and it is what ties a
 * payment to an organization. The link is now created per organization and also
 * carries `metadata.tenantId`, so this is no longer the *only* route — but it
 * is the one the checkout session itself carries, and `activate()` still reads
 * it first.
 *
 * `prefilled_email` is gone. It was a convenience on a link shared by everyone;
 * on a link belonging to one organization it would pin the payer to whoever
 * happened to click subscribe, and the point of an emailed link is that it can
 * be forwarded to whoever holds the company card.
 */
function buildPaymentUrl(link: string, tenantId: string): string {
  const url = new URL(link);

  url.searchParams.set("client_reference_id", tenantId);

  return url.toString();
}

/** P2002. The duplicate-key error, which here means a concurrent request won. */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "P2002"
  );
}
