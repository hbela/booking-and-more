import type { PrismaClient } from "@bam/db";
import type { Logger } from "@bam/observability";
import type { SubscribablePlan } from "@bam/contracts";
import type { BillingoClient, BillingoDocument, BillingoPartnerInput } from "./billingo.client.js";
import type { StripePaidInvoiceLoader, StripePaidInvoice } from "../stripe/stripe.client.js";

export interface BillingoInvoiceIssuerOptions {
  prisma: PrismaClient;
  logger: Logger;
  client: BillingoClient;
  loadStripeInvoice: StripePaidInvoiceLoader;
  bankAccountId: number;
  documentBlockId: number;
  vatCode: "AAM";
}

export type BillingoInvoiceIssuer = (input: {
  tenantId: string;
  plan: SubscribablePlan;
  stripeInvoiceId: string;
  stripeSubscriptionId: string;
}) => Promise<void>;

export function createBillingoInvoiceIssuer(
  options: BillingoInvoiceIssuerOptions,
): BillingoInvoiceIssuer {
  return async (input) => {
    const existing = await options.prisma.billingoInvoice.findUnique({
      where: { stripeInvoiceId: input.stripeInvoiceId },
      select: { id: true },
    });
    if (existing !== null) return;

    const invoice = await options.loadStripeInvoice(input.stripeInvoiceId);
    if (invoice.subscriptionId !== null && invoice.subscriptionId !== input.stripeSubscriptionId) {
      throw new Error(
        `Stripe invoice ${invoice.id} belongs to subscription ${invoice.subscriptionId}, not ${input.stripeSubscriptionId}`,
      );
    }
    if (invoice.amountPaidMinor === 0) {
      options.logger.debug(
        { stripeInvoiceId: invoice.id },
        "billingo: zero-value Stripe invoice skipped",
      );
      return;
    }
    if (invoice.amountPaidMinor < 0) {
      throw new Error(`Stripe invoice ${invoice.id} has a negative paid amount`);
    }
    if (invoice.currency !== "HUF") {
      throw new Error(`Stripe invoice ${invoice.id} uses unsupported currency ${invoice.currency}`);
    }

    const tenant = await options.prisma.tenant.findUniqueOrThrow({
      where: { id: input.tenantId },
      select: { defaultLanguage: true },
    });
    const partnerInput = partnerFromStripe(invoice);
    const partner = await syncPartner(input.tenantId, invoice.customerId, partnerInput, options);

    const recovered = await options.client.getDocumentByVendorId(invoice.id);
    const document =
      recovered ??
      (await options.client.createDocument({
        vendor_id: invoice.id,
        partner_id: partner.billingoPartnerId,
        block_id: options.documentBlockId,
        bank_account_id: options.bankAccountId,
        type: "invoice",
        fulfillment_date: budapestDate(invoice.paidAt),
        due_date: budapestDate(invoice.paidAt),
        payment_method: "bankcard",
        language: tenant.defaultLanguage === "en" ? "en" : "hu",
        currency: "HUF",
        electronic: true,
        paid: true,
        items: [
          {
            name: planName(input.plan),
            unit_price: invoice.amountPaidMinor,
            unit_price_type: "gross",
            quantity: 1,
            unit: tenant.defaultLanguage === "en" ? "month" : "hó",
            vat: options.vatCode,
          },
        ],
        comment: `Stripe invoice: ${invoice.id}`,
      }));

    await saveInvoice(input.tenantId, partner.id, invoice, document, options);
    options.logger.info(
      {
        tenantId: input.tenantId,
        stripeInvoiceId: invoice.id,
        billingoDocumentId: document.id,
      },
      recovered === null ? "billingo: invoice created" : "billingo: invoice reconciled",
    );
  };
}

async function syncPartner(
  tenantId: string,
  stripeCustomerId: string,
  input: BillingoPartnerInput,
  options: BillingoInvoiceIssuerOptions,
) {
  const stored = await options.prisma.billingoPartner.findUnique({ where: { tenantId } });

  if (stored !== null) {
    await options.client.updatePartner(stored.billingoPartnerId, input);
    if (stored.stripeCustomerId !== stripeCustomerId) {
      return options.prisma.billingoPartner.update({
        where: { id: stored.id },
        data: { stripeCustomerId },
      });
    }
    return stored;
  }

  const candidates = await options.client.findPartners(input.emails[0] ?? input.name);
  const matches = candidates.filter((candidate) => samePartner(candidate, input));
  if (matches.length > 1) {
    throw new Error(`Billingo partner lookup is ambiguous for tenant ${tenantId}`);
  }

  const remote = matches[0] ?? (await options.client.createPartner(input));

  return options.prisma.billingoPartner.upsert({
    where: { tenantId },
    update: { stripeCustomerId, billingoPartnerId: remote.id },
    create: { tenantId, stripeCustomerId, billingoPartnerId: remote.id },
  });
}

function partnerFromStripe(invoice: StripePaidInvoice): BillingoPartnerInput {
  const { customer } = invoice;
  const missing = [
    ["name", customer.name],
    ["email", customer.email],
    ["country", customer.address.country],
    ["postal code", customer.address.postalCode],
    ["city", customer.address.city],
    ["address line", customer.address.line1],
  ].filter((entry) => entry[1] === null || entry[1] === "");

  if (missing.length > 0) {
    throw new Error(
      `Stripe invoice ${invoice.id} is missing customer ${missing.map(([field]) => field).join(", ")}`,
    );
  }

  const country = customer.address.country!;
  const taxcode = customer.taxId ?? undefined;
  const street = [customer.address.line1, customer.address.line2].filter(Boolean).join(", ");

  return {
    name: customer.name!,
    emails: [customer.email!],
    address: {
      country_code: country,
      post_code: customer.address.postalCode!,
      city: customer.address.city!,
      address: street,
    },
    tax_type:
      country === "HU" ? (taxcode === undefined ? "NO_TAX_NUMBER" : "HAS_TAX_NUMBER") : "FOREIGN",
    ...(taxcode === undefined ? {} : { taxcode }),
  };
}

function samePartner(candidate: BillingoPartnerInput, expected: BillingoPartnerInput): boolean {
  const normalize = (value: string) => value.trim().toLocaleLowerCase("hu");

  return (
    normalize(candidate.name) === normalize(expected.name) &&
    candidate.emails.some((email) =>
      expected.emails.some((value) => normalize(email) === normalize(value)),
    ) &&
    candidate.address.country_code === expected.address.country_code &&
    normalize(candidate.address.post_code) === normalize(expected.address.post_code) &&
    normalize(candidate.address.city) === normalize(expected.address.city) &&
    normalize(candidate.address.address) === normalize(expected.address.address)
  );
}

async function saveInvoice(
  tenantId: string,
  partnerId: string,
  invoice: StripePaidInvoice,
  document: BillingoDocument,
  options: BillingoInvoiceIssuerOptions,
): Promise<void> {
  await options.prisma.billingoInvoice.upsert({
    where: { stripeInvoiceId: invoice.id },
    update: {},
    create: {
      tenantId,
      partnerId,
      stripeInvoiceId: invoice.id,
      billingoDocumentId: document.id,
      billingoInvoiceNumber: document.invoice_number,
      grossTotalMinor: invoice.amountPaidMinor,
      currency: invoice.currency,
    },
  });
}

function planName(plan: SubscribablePlan): string {
  return plan === "PROFESSIONAL" ? "Booking and More — AI Receptionist" : "Booking and More — Form";
}

function budapestDate(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Budapest",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value;

  return `${value("year")}-${value("month")}-${value("day")}`;
}
