import { config as loadDotenv } from "dotenv";
import Stripe from "stripe";

loadDotenv({ path: "../../.env", quiet: true });

const APPLY = process.argv.includes("--apply");
const VERIFY = process.argv.includes("--verify");
const CATALOG = [
  {
    plan: "STARTER",
    name: "Booking and More — Form",
    description: "Dashboard and public online booking form.",
    unitAmount: 9_990,
    lookupKey: "bam_form_monthly_huf_v1",
  },
  {
    plan: "PROFESSIONAL",
    name: "Booking and More — AI Receptionist",
    description:
      "Online booking form plus AI chat, website widget, transcripts, and monthly AI allowance.",
    unitAmount: 24_990,
    lookupKey: "bam_ai_receptionist_monthly_huf_v1",
  },
];

if (!APPLY && !VERIFY) {
  console.log("Dry run — no Stripe objects were changed. Pass --apply to create missing objects.");
  for (const offer of CATALOG) {
    console.log(`${offer.plan}: ${offer.name}, ${offer.unitAmount} HUF/month, tax exclusive`);
  }
  process.exit(0);
}

const secretKey = process.env["STRIPE_SECRET_KEY"];
if (!secretKey) throw new Error("STRIPE_SECRET_KEY is required with --apply.");

const stripe = new Stripe(secretKey, {
  apiVersion: "2026-07-29.dahlia",
  appInfo: { name: "booking-and-more-catalog" },
});

if (VERIFY) {
  let valid = true;

  for (const offer of CATALOG) {
    const priceId = process.env[`STRIPE_PRICE_${offer.plan}`];
    if (!priceId) {
      console.error(`${offer.plan}: no Price ID is configured.`);
      valid = false;
      continue;
    }

    const price = await stripe.prices.retrieve(priceId);
    const matches =
      price.active &&
      price.currency === "huf" &&
      price.unit_amount === offer.unitAmount &&
      price.recurring?.interval === "month" &&
      price.tax_behavior === "exclusive";

    console.log(
      `${offer.plan}: ${matches ? "valid" : "mismatch"} (${price.unit_amount ?? "unknown"} ${price.currency.toUpperCase()}/${price.recurring?.interval ?? "not recurring"}, tax ${price.tax_behavior ?? "unspecified"})`,
    );
    valid &&= matches;
  }

  if (!valid) process.exitCode = 1;
  process.exit();
}

const existingProducts = await stripe.products.list({ active: true, limit: 100 });

for (const offer of CATALOG) {
  let product = existingProducts.data.find(
    (candidate) => candidate.metadata["bam_plan"] === offer.plan,
  );

  if (!product) {
    product = await stripe.products.create(
      {
        name: offer.name,
        description: offer.description,
        metadata: { bam_plan: offer.plan },
        ...(process.env["STRIPE_SAAS_TAX_CODE"]
          ? { tax_code: process.env["STRIPE_SAAS_TAX_CODE"] }
          : {}),
      },
      { idempotencyKey: `bam-catalog-product-${offer.plan.toLowerCase()}-v1` },
    );
  }

  const prices = await stripe.prices.list({ product: product.id, active: true, limit: 100 });
  let price = prices.data.find(
    (candidate) =>
      candidate.currency === "huf" &&
      candidate.unit_amount === offer.unitAmount &&
      candidate.recurring?.interval === "month" &&
      candidate.tax_behavior === "exclusive",
  );

  if (!price) {
    price = await stripe.prices.create(
      {
        product: product.id,
        currency: "huf",
        unit_amount: offer.unitAmount,
        recurring: { interval: "month" },
        tax_behavior: "exclusive",
        lookup_key: offer.lookupKey,
        metadata: { bam_plan: offer.plan },
      },
      { idempotencyKey: `bam-catalog-price-${offer.plan.toLowerCase()}-huf-v1` },
    );
  }

  console.log(`STRIPE_PRICE_${offer.plan}=${price.id}`);
}

console.log(
  "Review Stripe Tax registrations, business origin, Customer Portal upgrade/downgrade rules, and test mode before copying these IDs to production.",
);
