import { config as loadDotenv } from "dotenv";
import Stripe from "stripe";

loadDotenv({ path: "../../.env", quiet: true });

const APPLY = process.argv.includes("--apply");
const VERIFY = process.argv.includes("--verify");
const PORTAL = process.argv.includes("--portal");
// Stripe accepts HUF charges with two decimal places, so API amounts are in
// fillér even though prices are normally presented as whole forints. HUF is
// zero-decimal only for payouts, not for charges.
const HUF_MINOR_UNITS_PER_FORINT = 100;
// Stripe stores product descriptions as literal catalog text; the Payment
// Link locale only translates Stripe's UI. This HUF catalog uses Hungarian.
const CATALOG = [
  {
    plan: "STARTER",
    name: "Booking and More — Form",
    description: "Vezérlőpult és nyilvános online időpontfoglaló űrlap.",
    amountHuf: 9_990,
    lookupKey: "bam_form_monthly_huf_v1",
  },
  {
    plan: "PROFESSIONAL",
    name: "Booking and More — Professional",
    description:
      "Online időpontfoglaló űrlap, AI chat, widget és naplók. Havi 150 beszélgetés, legfeljebb napi 30.",
    amountHuf: 29_900,
    lookupKey: "bam_professional_monthly_huf_v2",
  },
  {
    plan: "PROFESSIONAL_PLUS",
    name: "Booking and More — Professional Plus",
    description: "AI recepciós: havi 300 beszélgetés, legfeljebb napi 30.",
    amountHuf: 59_800,
    lookupKey: "bam_professional_plus_monthly_huf_v1",
  },
];

const stripeUnitAmount = (amountHuf) => amountHuf * HUF_MINOR_UNITS_PER_FORINT;

if (!APPLY && !VERIFY) {
  console.log("Dry run — no Stripe objects were changed. Pass --apply to create missing objects.");
  for (const offer of CATALOG) {
    console.log(`${offer.plan}: ${offer.name}, ${offer.amountHuf} HUF/month, AAM (no VAT)`);
  }
  process.exit(0);
}

const secretKey = process.env["STRIPE_SECRET_KEY"];
if (!secretKey) throw new Error("STRIPE_SECRET_KEY is required with --apply.");

if (process.argv.includes("--test-only") && !secretKey.startsWith("sk_test_"))
  throw new Error("--test-only requires a Stripe test key; no changes made.");

const stripe = new Stripe(secretKey, {
  apiVersion: "2026-07-29.dahlia",
  appInfo: { name: "booking-and-more-catalog" },
});

if (VERIFY) {
  let valid = true;
  const configuredPrices = [];

  for (const offer of CATALOG) {
    const priceId = process.env[`STRIPE_PRICE_${offer.plan}`];
    if (!priceId) {
      console.error(`${offer.plan}: no Price ID is configured.`);
      valid = false;
      continue;
    }

    const price = await stripe.prices.retrieve(priceId);
    configuredPrices.push(price.id);
    const matches =
      price.active &&
      price.currency === "huf" &&
      price.unit_amount === stripeUnitAmount(offer.amountHuf) &&
      price.recurring?.interval === "month" &&
      price.tax_behavior === "unspecified";

    console.log(
      `${offer.plan}: ${matches ? "valid" : "mismatch"} (${price.unit_amount === null ? "unknown" : price.unit_amount / HUF_MINOR_UNITS_PER_FORINT} ${price.currency.toUpperCase()}/${price.recurring?.interval ?? "not recurring"}, tax ${price.tax_behavior ?? "unspecified"})`,
    );
    valid &&= matches;
  }

  if (PORTAL) {
    const portal = await defaultPortal();
    const configuration = await stripe.billingPortal.configurations.retrieve(portal.id, {
      expand: ["features.subscription_update.products"],
    });
    const update = configuration.features.subscription_update;
    const offered = update.products?.flatMap((product) => product.prices) ?? [];
    const matches =
      update.enabled &&
      update.default_allowed_updates.includes("price") &&
      update.proration_behavior === "always_invoice" &&
      update.schedule_at_period_end.conditions.some(
        (condition) => condition.type === "decreasing_item_amount",
      ) &&
      configuredPrices.every((price) => offered.includes(price));
    console.log(`Customer Portal ${portal.id}: ${matches ? "valid" : "mismatch"}`);
    valid &&= matches;
  }

  if (!valid) process.exitCode = 1;
  process.exit();
}

const existingProducts = await stripe.products.list({ active: true, limit: 100 });
const portalProducts = [];

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
      { idempotencyKey: `bam-catalog-product-${offer.plan.toLowerCase()}-v2` },
    );
  }

  if (product.description !== offer.description || product.name !== offer.name) {
    product = await stripe.products.update(product.id, {
      name: offer.name,
      description: offer.description,
    });
  }

  const prices = await stripe.prices.list({ product: product.id, active: true, limit: 100 });
  let price = prices.data.find(
    (candidate) =>
      candidate.currency === "huf" &&
      candidate.unit_amount === stripeUnitAmount(offer.amountHuf) &&
      candidate.recurring?.interval === "month" &&
      candidate.tax_behavior === "unspecified",
  );

  if (!price) {
    price = await stripe.prices.create(
      {
        product: product.id,
        currency: "huf",
        unit_amount: stripeUnitAmount(offer.amountHuf),
        recurring: { interval: "month" },
        tax_behavior: "unspecified",
        lookup_key: offer.lookupKey,
        // A previous catalogue version may already own this stable key. Stripe
        // keeps lookup keys unique even when that old price is inactive or no
        // longer matches the intended amount/recurrence. Move the key to the
        // replacement instead of making catalogue repair fail halfway through.
        transfer_lookup_key: true,
        metadata: { bam_plan: offer.plan },
      },
      // v4 corrects PROFESSIONAL from 24,900 to 24,990 Ft. Bump this on every
      // amount change, and never merely re-run: Stripe **replayed** the v3 key
      // and returned the 24,900 price it had created hours earlier, so `--apply`
      // printed a price ID and a success line while changing nothing. It does
      // not always reject a mismatched replay — treat `--verify` as the only
      // evidence the catalogue is right, never the exit code of `--apply`.
      // v5 removes the inclusive tax behavior for the seller's AAM status.
      { idempotencyKey: `bam-catalog-price-${offer.plan.toLowerCase()}-huf-v6` },
    );
  }

  console.log(`STRIPE_PRICE_${offer.plan}=${price.id}`);
  portalProducts.push({ product: product.id, prices: [price.id] });
}

if (PORTAL) {
  const portal = await defaultPortal();
  await stripe.billingPortal.configurations.update(portal.id, {
    features: {
      subscription_update: {
        enabled: true,
        default_allowed_updates: ["price"],
        products: portalProducts,
        proration_behavior: "always_invoice",
        billing_cycle_anchor: "unchanged",
        schedule_at_period_end: { conditions: [{ type: "decreasing_item_amount" }] },
      },
    },
  });
  console.log(`Customer Portal ${portal.id}: configured for all three plans.`);
}

console.log(
  "AAM catalog: keep automatic tax disabled on payment links. Review Customer Portal upgrade/downgrade rules and test mode before copying these IDs to production.",
);

async function defaultPortal() {
  const configurations = await stripe.billingPortal.configurations.list({
    active: true,
    limit: 100,
  });
  const portal = configurations.data.find((configuration) => configuration.is_default);
  if (!portal)
    throw new Error("Save a default Stripe Customer Portal configuration before using --portal.");
  return portal;
}
