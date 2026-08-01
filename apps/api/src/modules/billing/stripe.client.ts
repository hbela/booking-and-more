import Stripe from "stripe";

/**
 * Stripe, constructed on first use.
 *
 * CLAUDE.md rule 4: a missing key degrades billing and nothing else. The
 * predecessor called `new Stripe(...)` at module scope, so an API instance with
 * no Stripe credentials could not boot at all — a booking system refusing to
 * start because nobody had configured payments yet.
 *
 * There is exactly one thing we need the SDK for: verifying webhook signatures.
 * Payment Links are static URLs held in config, so selling a subscription
 * involves no Stripe API call at all
 * (docs/phase-9-subscription-and-activation.md §1.2).
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
}) => Promise<{ url: string }>;

export function createStripePortalSession(options: StripeOptions): PortalSessionCreator {
  return async ({ customerId, returnUrl }) => {
    const session = await getStripe(options).billingPortal.sessions.create({
      customer: customerId,
      return_url: returnUrl,
    });

    return { url: session.url };
  };
}
