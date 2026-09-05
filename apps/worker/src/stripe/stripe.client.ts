import Stripe from "stripe";

/**
 * The worker's one outbound call to Stripe.
 * docs/phase-9-owner-language-and-return-paths.md §5.3.
 *
 * Everything else here consumes `stripe_events` and writes PostgreSQL — the
 * poller deliberately does not talk to Stripe at all, which is why a Stripe
 * outage cannot stop an already-recorded payment from activating a tenant. This
 * file is the single exception, and it is kept to one narrow function rather
 * than exposing the client so that stays true by construction.
 *
 * Constructed on first use, per CLAUDE.md rule 4: a deployment with no
 * `STRIPE_SECRET_KEY` must idle rather than fail to boot. `worker.ts` passes the
 * setter only when the key is present, so the absence degrades one cosmetic
 * property of an invoice and nothing else.
 */

let client: Stripe | undefined;

export interface StripeOptions {
  secretKey: string;
}

function getStripe(options: StripeOptions): Stripe {
  client ??= new Stripe(options.secretKey, {
    // Pinned for the same reason as the API's client: an API version bumped in
    // the Stripe dashboard must not silently change the shape of what we parse.
    // Keep this equal to `apps/api/src/modules/billing/stripe.client.ts` — two
    // pins that drift apart are worse than one, because the object a webhook
    // delivers and the object this reads back would come from different
    // versions of the same API.
    apiVersion: "2026-07-29.dahlia",
    appInfo: { name: "booking-and-more-worker" },
  });

  return client;
}

/** Test seam: the singleton would otherwise leak a key between test cases. */
export function resetStripeForTests(): void {
  client = undefined;
}

/**
 * Pins the organization's language onto its Stripe customer.
 *
 * **This is what decides the language of every invoice Stripe renders**, plus
 * its hosted invoice page and its billing emails — none of which pass through
 * our templates, so none of which `next-intl` can reach. Stripe reads
 * `preferred_locales` off the customer at invoice finalization; there is no
 * per-invoice override.
 *
 * ## Why Checkout's own `locale` was not enough
 *
 * `buildPaymentUrl` already appends `?locale=…` to the Payment Link, and that
 * does localize the checkout page including its number formatting. It does not
 * survive the payment: Checkout populates `preferred_locales` from the payer's
 * **browser**, not from the session locale. Every customer on the account was
 * therefore `["en-US"]` while carrying a Hungarian address, and every invoice
 * rendered in English with `24,990.00 Ft` instead of `24 990,00 Ft`.
 *
 * Passing it explicitly is also the only version that is *deterministic*. A
 * Hungarian owner forwarding the payment link to a colleague whose laptop is in
 * English would otherwise decide the language of the organization's invoices for
 * as long as the subscription lasts.
 *
 * Returned as a plain function rather than the client, so the processor depends
 * on the shape of the call and stays testable without a network round trip —
 * the same seam `PortalSessionCreator` uses on the API side.
 */
export type CustomerLocaleSetter = (input: {
  customerId: string;
  /**
   * `hu` or `en`, already narrowed by `resolveAppLocale`. Typed `string` rather
   * than Stripe's locale union because that union is left open by the SDK and
   * would not have checked anything.
   */
  locale: string;
}) => Promise<void>;

export function createStripeCustomerLocaleSetter(options: StripeOptions): CustomerLocaleSetter {
  return async ({ customerId, locale }) => {
    await getStripe(options).customers.update(customerId, {
      preferred_locales: [locale],
    });
  };
}

export interface StripePaidInvoice {
  id: string;
  /** Stripe charge amount in the currency's API minor unit (fillér for HUF). */
  amountPaidStripeMinor: number;
  currency: string;
  customerId: string;
  subscriptionId: string | null;
  paidAt: Date;
  customer: {
    name: string | null;
    email: string | null;
    taxId: string | null;
    address: {
      country: string | null;
      postalCode: string | null;
      city: string | null;
      line1: string | null;
      line2: string | null;
    };
  };
}

export type StripePaidInvoiceLoader = (invoiceId: string) => Promise<StripePaidInvoice>;

/** Retrieves the finalized snapshot Stripe signed, including its buyer data. */
export function createStripePaidInvoiceLoader(options: StripeOptions): StripePaidInvoiceLoader {
  return async (invoiceId) => {
    const invoice = await getStripe(options).invoices.retrieve(invoiceId);
    const customerId =
      typeof invoice.customer === "string" ? invoice.customer : (invoice.customer?.id ?? null);
    if (customerId === null) throw new Error(`Stripe invoice ${invoice.id} has no customer`);

    const subscription = invoice.parent?.subscription_details?.subscription;
    const subscriptionId =
      typeof subscription === "string" ? subscription : (subscription?.id ?? null);
    const paidAt = invoice.status_transitions.paid_at ?? invoice.created;
    const taxId = invoice.customer_tax_ids?.find((entry) => entry.value !== "")?.value ?? null;

    return {
      id: invoice.id,
      amountPaidStripeMinor: invoice.amount_paid,
      currency: invoice.currency.toUpperCase(),
      customerId,
      subscriptionId,
      paidAt: new Date(paidAt * 1_000),
      customer: {
        name: invoice.customer_name,
        email: invoice.customer_email,
        taxId,
        address: {
          country: invoice.customer_address?.country ?? null,
          postalCode: invoice.customer_address?.postal_code ?? null,
          city: invoice.customer_address?.city ?? null,
          line1: invoice.customer_address?.line1 ?? null,
          line2: invoice.customer_address?.line2 ?? null,
        },
      },
    };
  };
}
