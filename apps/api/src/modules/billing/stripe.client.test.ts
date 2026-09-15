import { beforeEach, describe, expect, it, vi } from "vitest";
import { createStripePaymentLink, resetStripeForTests } from "./stripe.client.js";

const { createLink } = vi.hoisted(() => ({ createLink: vi.fn() }));

vi.mock("stripe", () => ({
  default: class {
    paymentLinks = { create: createLink };
  },
}));

describe("AAM payment links", () => {
  beforeEach(() => {
    resetStripeForTests();
    createLink.mockReset();
    createLink.mockResolvedValue({ id: "plink_test", url: "https://buy.stripe.com/test" });
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
