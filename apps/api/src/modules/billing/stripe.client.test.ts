import { beforeEach, describe, expect, it, vi } from "vitest";
import { createStripePaymentLink, resetStripeForTests } from "./stripe.client.js";

const { createLink, retrievePrice } = vi.hoisted(() => ({
  createLink: vi.fn(),
  retrievePrice: vi.fn(),
}));

vi.mock("stripe", () => ({
  default: class {
    prices = { retrieve: retrievePrice };
    paymentLinks = { create: createLink };
  },
}));

describe("AAM payment links", () => {
  beforeEach(() => {
    resetStripeForTests();
    retrievePrice.mockResolvedValue({
      livemode: false,
      active: true,
      currency: "huf",
      unit_amount: 2499000,
      recurring: { interval: "month", interval_count: 1 },
    });
    createLink.mockReset();
    createLink.mockResolvedValue({ id: "plink_test", url: "https://buy.stripe.com/test" });
  });

  it("refuses a price from another billing mode before creating a link", async () => {
    retrievePrice.mockResolvedValue({ livemode: true });
    await expect(
      createStripePaymentLink({ secretKey: "sk_test_mock" })({
        priceId: "price_wrong",
        tenantId: "tenant_test",
        plan: "PROFESSIONAL",
        trialPeriodDays: null,
        returnUrl: "https://example.test",
      }),
    ).rejects.toThrow("configured mode");
    expect(createLink).not.toHaveBeenCalled();
  });

  it.each([
    ["STARTER", 999000],
    ["PROFESSIONAL", 2499000],
  ])("accepts the correct Stripe minor-unit amount for %s", async (plan, amount) => {
    retrievePrice.mockResolvedValue({
      livemode: false,
      active: true,
      currency: "huf",
      unit_amount: amount,
      recurring: { interval: "month", interval_count: 1 },
    });
    await createStripePaymentLink({ secretKey: "sk_test_mock" })({
      priceId: "price_test",
      tenantId: "tenant_test",
      plan: String(plan),
      trialPeriodDays: null,
      returnUrl: "https://example.test",
    });
    expect(createLink).toHaveBeenCalledOnce();
  });

  it.each([
    ["STARTER", 9990],
    ["PROFESSIONAL", 24990],
  ])("rejects a price 100 times too low for %s", async (plan, amount) => {
    retrievePrice.mockResolvedValue({
      livemode: false,
      active: true,
      currency: "huf",
      unit_amount: amount,
      recurring: { interval: "month", interval_count: 1 },
    });
    await expect(
      createStripePaymentLink({ secretKey: "sk_test_mock" })({
        priceId: "price_test",
        tenantId: "tenant_test",
        plan: String(plan),
        trialPeriodDays: null,
        returnUrl: "https://example.test",
      }),
    ).rejects.toThrow("monthly catalogue");
    expect(createLink).not.toHaveBeenCalled();
  });
  it.each([null, 30])("does not calculate VAT with trial days %s", async (trialPeriodDays) => {
    await createStripePaymentLink({ secretKey: "sk_test_mock" })({
      priceId: "price_test",
      tenantId: "tenant_test",
      plan: "PROFESSIONAL",
      trialPeriodDays,
      returnUrl: "http://localhost:3000/dashboard/subscription",
    });

    const params = createLink.mock.calls[0]?.[0];
    expect(params).toMatchObject({
      automatic_tax: { enabled: false },
      line_items: [{ price: "price_test", quantity: 1 }],
      billing_address_collection: "required",
      tax_id_collection: { enabled: true },
    });
    expect(params.line_items[0]).not.toHaveProperty("tax_rates");
    expect(params.subscription_data).not.toHaveProperty("default_tax_rates");
  });
});
