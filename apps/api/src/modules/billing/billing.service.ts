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

import type { PortalSessionCreator } from "./stripe.client.js";

/**
 * Selling a subscription. docs/phase-9-subscription-and-activation.md §3.
 *
 * There is no Stripe API call here. A Payment Link is a permanent URL held in
 * config, so "start a subscription" is building a URL and asking for an email —
 * which is why billing degrades to "unavailable" rather than failing when
 * Stripe is unconfigured.
 */

/**
 * Payment links by plan; a plan absent here is simply not sold.
 *
 * Two per plan, because a Payment Link's free trial is a property of the link
 * and cannot be varied per customer the way Checkout's `trial_period_days` can
 * (docs/phase-9-subscription-lifecycle.md §2.1). `trial` is what a first-time
 * organization gets; `noTrial` is for one that has already had its thirty days.
 */
export interface PlanLinks {
  trial: string;
  noTrial: string;
}

export type PaymentLinks = Partial<Record<SubscribablePlan, PlanLinks>>;

export interface BillingServiceOptions {
  paymentLinks: PaymentLinks;
  /**
   * Absent when Stripe is unconfigured, which is what turns the portal into a
   * 503 with no `if (env…)` down here (docs/phase-9-customer-portal.md §2.2).
   * Injected rather than imported so the one call this service makes to a third
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

  /** Which plans can actually be bought right now. */
  availablePlans(): SubscribablePlan[] {
    return (Object.keys(this.options.paymentLinks) as SubscribablePlan[]).filter(
      (plan) => this.options.paymentLinks[plan] !== undefined,
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
    const links = this.options.paymentLinks[input.plan];

    if (links === undefined) {
      throw new NotFoundError(
        `The ${input.plan} plan is not available. Please contact us.`,
        ErrorCodes.VALIDATION_FAILED,
      );
    }

    const existing = await this.currentSubscription(input.tenantId);

    // Stops a double-clicked button producing two subscriptions for one
    // organization — listed in phase-9 §2.7 among the things worth taking from
    // the predecessor, which got this part right. A CANCELED row is not live,
    // so a returning customer passes here and is sent the no-trial link.
    if (isLiveSubscription(existing?.status)) {
      throw new ConflictError(
        ErrorCodes.VALIDATION_FAILED,
        "This organization already has a subscription.",
      );
    }

    // The trial-once gate. `trialUsedAt` is on the subscription row precisely
    // because that row outlives a cancellation, so this is the path a returning
    // customer takes: CANCELED is not a live status, so they get here, and the
    // stamp is what stops them collecting another thirty free days.
    const trial = existing?.trialUsedAt == null;
    const link = trial ? links.trial : links.noTrial;

    const tenant = await this.prisma.tenant.findUnique({
      where: { id: input.tenantId },
      select: { id: true, name: true },
    });

    if (!tenant) throw new NotFoundError("That organization does not exist.");

    const paymentUrl = buildPaymentUrl(link, input.tenantId, input.recipientEmail);

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
          paymentUrl,
          // So the email can say "start your free trial" or "resume your
          // subscription" — the same link with two very different meanings.
          trial,
        },
      },
    });

    return { paymentUrl, emailedTo: input.recipientEmail, trial };
  }
}

/**
 * `client_reference_id` is the entire join key.
 *
 * Stripe echoes it back on `checkout.session.completed`, and it is the only
 * thing tying a payment to an organization — a Payment Link is shared by every
 * customer on that plan, so without it a completed payment arrives with nothing
 * to attach it to.
 *
 * `prefilled_email` is a convenience only; the payer may legitimately be
 * somebody else, which is the point of emailing a forwardable link.
 */
function buildPaymentUrl(link: string, tenantId: string, email: string): string {
  const url = new URL(link);

  url.searchParams.set("client_reference_id", tenantId);
  url.searchParams.set("prefilled_email", email);

  return url.toString();
}
