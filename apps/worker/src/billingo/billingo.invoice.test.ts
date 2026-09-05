import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@bam/db";
import { createLogger } from "@bam/observability";
import { createBillingoInvoiceIssuer } from "./billingo.invoice.js";
import type { BillingoClient, BillingoPartner } from "./billingo.client.js";
import type { StripePaidInvoice } from "../stripe/stripe.client.js";

const log = createLogger({ service: "billingo-test", level: "silent", pretty: false });

function paidInvoice(overrides: Partial<StripePaidInvoice> = {}): StripePaidInvoice {
  return {
    id: "in_paid",
    amountPaidStripeMinor: 2_499_000,
    currency: "HUF",
    customerId: "cus_123",
    subscriptionId: "sub_123",
    paidAt: new Date("2026-08-31T22:30:00.000Z"),
    customer: {
      name: "Teszt Elek",
      email: "teszt@example.com",
      taxId: null,
      address: {
        country: "HU",
        postalCode: "1133",
        city: "Budapest",
        line1: "Teszt utca 1.",
        line2: null,
      },
    },
    ...overrides,
  };
}

function harness(input: { invoice?: StripePaidInvoice; recovered?: boolean } = {}) {
  let localPartner: {
    id: string;
    tenantId: string;
    stripeCustomerId: string;
    billingoPartnerId: number;
  } | null = null;
  let localInvoice: { id: string } | null = null;
  const partner: BillingoPartner = {
    id: 77,
    name: "Teszt Elek",
    emails: ["teszt@example.com"],
    address: { country_code: "HU", post_code: "1133", city: "Budapest", address: "Teszt utca 1." },
    tax_type: "NO_TAX_NUMBER",
  };
  const document = { id: 88, invoice_number: "TEST-2026-1", gross_total: 24_990, currency: "HUF" };
  const prisma = {
    billingoInvoice: {
      findUnique: vi.fn(() => Promise.resolve(localInvoice)),
      upsert: vi.fn(() => {
        localInvoice = { id: "local-invoice" };
        return Promise.resolve(localInvoice);
      }),
    },
    billingoPartner: {
      findUnique: vi.fn(() => Promise.resolve(localPartner)),
      update: vi.fn(() => Promise.resolve(localPartner)),
      upsert: vi.fn(() => {
        localPartner = {
          id: "local-partner",
          tenantId: "tenant-1",
          stripeCustomerId: "cus_123",
          billingoPartnerId: 77,
        };
        return Promise.resolve(localPartner);
      }),
    },
    tenant: { findUniqueOrThrow: vi.fn(() => Promise.resolve({ defaultLanguage: "hu" })) },
  };
  const client: BillingoClient = {
    listBankAccounts: vi.fn(),
    listDocumentBlocks: vi.fn(),
    findPartners: vi.fn(() => Promise.resolve([])),
    createPartner: vi.fn(() => Promise.resolve(partner)),
    updatePartner: vi.fn(() => Promise.resolve(partner)),
    getDocumentByVendorId: vi.fn(() => Promise.resolve(input.recovered ? document : null)),
    createDocument: vi.fn(() => Promise.resolve(document)),
  };
  const loadStripeInvoice = vi.fn(() => Promise.resolve(input.invoice ?? paidInvoice()));
  const issue = createBillingoInvoiceIssuer({
    prisma: prisma as unknown as PrismaClient,
    logger: log,
    client,
    loadStripeInvoice,
    bankAccountId: 9,
    documentBlockId: 8,
    vatCode: "AAM",
  });

  return { issue, prisma, client, loadStripeInvoice, document };
}

describe("Billingo invoice issuer", () => {
  it("converts Stripe fillér to HUF and copies the Budapest payment date", async () => {
    const { issue, client, prisma } = harness();

    await issue({
      tenantId: "tenant-1",
      plan: "PROFESSIONAL",
      stripeInvoiceId: "in_paid",
      stripeSubscriptionId: "sub_123",
    });

    expect(client.createDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        vendor_id: "in_paid",
        fulfillment_date: "2026-09-01",
        due_date: "2026-09-01",
        paid: true,
        items: [expect.objectContaining({ unit_price: 24_990, vat: "AAM" })],
      }),
    );
    expect(prisma.billingoInvoice.upsert).toHaveBeenCalledOnce();
  });

  it("reconciles a document created before the local database write", async () => {
    const { issue, client, prisma } = harness({ recovered: true });

    await issue({
      tenantId: "tenant-1",
      plan: "STARTER",
      stripeInvoiceId: "in_paid",
      stripeSubscriptionId: "sub_123",
    });

    expect(client.createDocument).not.toHaveBeenCalled();
    expect(prisma.billingoInvoice.upsert).toHaveBeenCalledOnce();
  });

  it("does no network work when the Stripe invoice is already mapped", async () => {
    const setup = harness();
    setup.prisma.billingoInvoice.findUnique.mockResolvedValueOnce({ id: "already-there" });

    await setup.issue({
      tenantId: "tenant-1",
      plan: "STARTER",
      stripeInvoiceId: "in_paid",
      stripeSubscriptionId: "sub_123",
    });

    expect(setup.loadStripeInvoice).not.toHaveBeenCalled();
    expect(setup.client.createDocument).not.toHaveBeenCalled();
  });

  it("skips a zero-value trial invoice", async () => {
    const setup = harness({ invoice: paidInvoice({ amountPaidStripeMinor: 0 }) });

    await setup.issue({
      tenantId: "tenant-1",
      plan: "STARTER",
      stripeInvoiceId: "in_paid",
      stripeSubscriptionId: "sub_123",
    });

    expect(setup.client.findPartners).not.toHaveBeenCalled();
    expect(setup.client.createDocument).not.toHaveBeenCalled();
  });

  it("rejects a fractional-forint Stripe amount that cannot be mirrored exactly", async () => {
    const setup = harness({ invoice: paidInvoice({ amountPaidStripeMinor: 2_499_050 }) });

    await expect(
      setup.issue({
        tenantId: "tenant-1",
        plan: "PROFESSIONAL",
        stripeInvoiceId: "in_paid",
        stripeSubscriptionId: "sub_123",
      }),
    ).rejects.toThrow(/fractional HUF amount/);
    expect(setup.client.createDocument).not.toHaveBeenCalled();
  });

  it("rejects unsupported currency before creating a partner", async () => {
    const setup = harness({ invoice: paidInvoice({ currency: "EUR" }) });

    await expect(
      setup.issue({
        tenantId: "tenant-1",
        plan: "STARTER",
        stripeInvoiceId: "in_paid",
        stripeSubscriptionId: "sub_123",
      }),
    ).rejects.toThrow(/unsupported currency EUR/);
    expect(setup.client.findPartners).not.toHaveBeenCalled();
  });

  it("rejects incomplete legal billing details", async () => {
    const invoice = paidInvoice();
    invoice.customer.address.line1 = null;
    const setup = harness({ invoice });

    await expect(
      setup.issue({
        tenantId: "tenant-1",
        plan: "STARTER",
        stripeInvoiceId: "in_paid",
        stripeSubscriptionId: "sub_123",
      }),
    ).rejects.toThrow(/address line/);
    expect(setup.client.createDocument).not.toHaveBeenCalled();
  });
});
