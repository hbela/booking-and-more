import Stripe from "stripe";

/**
 * Stripe, constructed on first use.
 *
 * CLAUDE.md rule 4: a missing key degrades billing and nothing else. The
 * predecessor called `new Stripe(...)` at module scope, so an API instance with
 * no Stripe credentials could not boot at all — a booking system refusing to
 * start because nobody had configured payments yet.
 *
 * Three things need the SDK: verifying webhook signatures, opening a
 * customer-portal session, and creating the per-organization Payment Link that
 * selling a subscription now goes through.
 *
 * That last one is a deliberate reversal of
 * docs/phase-9-subscription-and-activation.md §1.2, which held the links in
 * config precisely so that selling needed no API call. It bought simplicity and
 * cost correctness: a link shared by every customer on a plan is permanent,
 * reusable and reachable from an old email, so nothing on our side could stop
 * one organization paying twice
 * (docs/phase-9-duplicate-subscription-prevention.md §2.2).
 */

let client: Stripe | undefined;

export interface StripeOptions {
  secretKey: string;
}

export function getStripe(options: StripeOptions): Stripe {
  client ??= new Stripe(options.secretKey, {
    // Pinned rather than left to the account's dashboard setting, so an API
    // upgrade there cannot silently change the shape of the objects this code
    // parses. The SDK types this as its own latest literal, so bumping `stripe`
    // makes this line a compile error rather than a runtime surprise — which is
    // the point.
    apiVersion: "2026-07-29.dahlia",
    // Surfaces our requests in Stripe's dashboard logs as ours.
    appInfo: { name: "booking-and-more" },
  });

  return client;
}

/** Test seam: the singleton would otherwise leak a key between test cases. */
export function resetStripeForTests(): void {
  client = undefined;
}

/**
 * A customer-portal session, for the owner to manage what they already bought.
 * docs/phase-9-customer-portal.md §2.
 *
 * The second — and now only other — thing the SDK is needed for. Unlike the
 * Payment Link, this genuinely cannot be a static URL: the session is scoped to
 * one Stripe customer, authenticates whoever holds it into that customer's
 * billing account, and expires within minutes (§1.1). It is created on demand
 * for a signed-in owner and redirected to at once.
 *
 * Returned as a plain function rather than exposing the client, so
 * `BillingService` depends on the shape of the call and not on Stripe.
 */
export type PortalSessionCreator = (input: {
  customerId: string;
  returnUrl: string;
  /**
   * The organization's language, so Stripe's own portal is not in a different
   * one from the screen the owner clicked through from
   * (docs/phase-9-owner-language-and-return-paths.md §5.1). Left unset, Stripe
   * uses the customer's `preferred_locales` or the browser — which is how a
   * Hungarian organization reached an English portal.
   */
  locale: string;
}) => Promise<{ url: string }>;

export function createStripePortalSession(options: StripeOptions): PortalSessionCreator {
  return async ({ customerId, returnUrl, locale }) => {
    const session = await getStripe(options).billingPortal.sessions.create({
      customer: customerId,
      return_url: returnUrl,
      // Typed `string` on our side rather than Stripe's locale union: the SDK
      // leaves that union open, so it would not have checked anything anyway.
      // `resolveAppLocale` is what guarantees this is `hu` or `en`, both of
      // which Stripe's portal supports.
      locale,
    });

    return { url: session.url };
  };
}

/**
 * A Payment Link for one organization, usable exactly once.
 * docs/phase-9-duplicate-subscription-prevention.md §4.1.
 *
 * Returned as a plain function for the same reason as the portal creator:
 * `BillingService` should depend on the shape of the call, not on Stripe.
 *
 * **There is deliberately no `locale` here.** `paymentLinks.create` has no such
 * parameter — only `checkout.sessions.create` does — so the hosted payment page
 * follows the buyer's browser and cannot be overridden. That is accepted rather
 * than worked around: the alternatives were an undocumented `?locale=` query
 * parameter that would fail silently, or a Checkout Session, which expires in 24
 * hours against a 14-day subscribe window
 * (docs/phase-9-owner-language-and-return-paths.md §5.2). Browser detection is
 * also arguably the better answer — the link is meant to be forwardable to
 * whoever holds the company card, and that person's browser says more about what
 * they read than the organization's configured default does.
 */
export type PaymentLinkCreator = (input: {
  priceId: string;
  tenantId: string;
  plan: string;
  /** Days of free trial, or `null` for an organization that has had one. */
  trialPeriodDays: number | null;
  /** The organization's subscription screen, in the organization's language. */
  returnUrl: string;
}) => Promise<{ id: string; url: string }>;

export function createStripePaymentLink(options: StripeOptions): PaymentLinkCreator {
  return async ({ priceId, tenantId, plan, trialPeriodDays, returnUrl }) => {
    const link = await getStripe(options).paymentLinks.create({
      line_items: [{ price: priceId, quantity: 1 }],

      // **The constraint this whole slice exists for.**
      //
      // Stripe refuses a second checkout on this link, at the moment of
      // checkout, on the one path our API does not sit on. Rule 14 across the
      // Stripe boundary: the system that owns the resource decides, and our
      // code translates the refusal — never a read-then-write on our side of a
      // network hop.
      //
      // Not a *proof*: two checkouts completing in the same instant is a race
      // inside Stripe that they document no guarantee for. It closes the
      // double-click, the re-opened email and the whole webhook-outage window,
      // which is every mechanism that produced the incident.
      restrictions: { completed_sessions: { limit: 1 } },

      subscription_data: {
        // Stamped on the *subscription*, not just the session. This is what
        // makes every later `customer.subscription.*` event self-attributing
        // and retires the ordering race that OrphanEventError exists for
        // (docs/phase-9-subscription-lifecycle.md §4).
        metadata: { tenantId },
        // Per organization, which a link created once per plan could not do —
        // and the reason the trial/no-trial link pair is gone (§4.2).
        ...(trialPeriodDays === null ? {} : { trial_period_days: trialPeriodDays }),
      },

      metadata: { tenantId, plan },

      // **Bring them back to the product they just bought.**
      // docs/phase-9-owner-language-and-return-paths.md §4.1.
      //
      // Without this the journey ended on Stripe's confirmation page and the
      // owner had to find their way back unaided.
      //
      // A redirect rather than a customised `hosted_confirmation`, because the
      // subscription screen already renders every state they can arrive in —
      // including *not activated yet*, since activation is a webhook and a fast
      // payer beats the event home. A static page would have to either lie or
      // say nothing.
      after_completion: { type: "redirect", redirect: { url: returnUrl } },

      // What the owner reads if they come back to a link they already used.
      // Left to Stripe's default it says only that the link is inactive, which
      // to somebody who has just paid reads as a failure rather than as
      // confirmation.
      inactive_message:
        "This payment link has already been used. Your subscription is active — sign in to your dashboard to manage it.",
    });

    return { id: link.id, url: link.url };
  };
}

/** Stops a link being buyable — used when the owner changes plan before paying. */
export type PaymentLinkDeactivator = (paymentLinkId: string) => Promise<void>;

/**
 * Has anybody completed a checkout on this link? Asked of Stripe, not of us.
 * docs/phase-9-duplicate-subscription-prevention.md §4.4.
 *
 * **This is the guard that does not depend on the path it protects.** The old
 * one read our `subscriptions` row, which only exists once the webhook has
 * landed — so it asked the payment path whether the payment path had finished
 * and got "no" for as long as delivery was late.
 *
 * `GET /v1/checkout/sessions` is a **list**, not a search. That distinction is
 * the whole reason this is trustworthy: `subscriptions.search` is documented as
 * "up to an hour behind during outages", which is the same stale-replica bug
 * with Stripe's lag substituted for ours (§3.1). A list is read straight
 * through and filters on `payment_link` and `status` natively.
 */
export type PaymentLinkUsageReader = (paymentLinkId: string) => Promise<boolean>;

/** The three link operations, bundled so "is Stripe configured" is one question. */
export interface PaymentLinkClient {
  create: PaymentLinkCreator;
  deactivate: PaymentLinkDeactivator;
  hasCompletedCheckout: PaymentLinkUsageReader;
}

export function createStripePaymentLinkClient(options: StripeOptions): PaymentLinkClient {
  return {
    create: createStripePaymentLink(options),

    deactivate: async (paymentLinkId) => {
      await getStripe(options).paymentLinks.update(paymentLinkId, { active: false });
    },

    hasCompletedCheckout: async (paymentLinkId) => {
      const sessions = await getStripe(options).checkout.sessions.list({
        payment_link: paymentLinkId,
        status: "complete",
        // One is all the question needs. A second would only tell us the
        // Stripe-side restriction had failed, which §5.1 in the worker reports
        // anyway and which this call cannot do anything about.
        limit: 1,
      });

      return sessions.data.length > 0;
    },
  };
}
