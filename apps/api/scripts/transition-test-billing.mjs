import Stripe from "stripe";
import { loadEnv } from "@bam/config";
import { createPrismaClient } from "@bam/db";
import { createCustomerPii } from "@bam/crypto";

const args = process.argv.slice(2);
const arg = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const tenantId = arg("--tenant");
const apply = args.includes("--apply");
if (apply && args.includes("--dry-run"))
  throw new Error("Dry-run cannot be combined with --apply.");
if (!tenantId || tenantId.startsWith("--"))
  throw new Error("Provide --tenant <exact tenant ID>. Default is dry-run.");
const env = loadEnv();
if (env.BILLING_MODE !== "test" || !env.STRIPE_SECRET_KEY?.startsWith("sk_test_"))
  throw new Error(
    "Use the old TEST Stripe account to verify references before switching to live keys.",
  );
if (
  apply &&
  (!args.includes("--maintenance") ||
    arg("--database") !== new URL(env.DATABASE_URL).pathname.slice(1))
)
  throw new Error(
    "Writes require --maintenance --database <exact name>, with API and worker stopped.",
  );
const prisma = createPrismaClient({ databaseUrl: env.DATABASE_URL });
const stripe = new Stripe(env.STRIPE_SECRET_KEY);
const pii = createCustomerPii(env.CUSTOMER_PII_ENCRYPTION_KEY, env.CUSTOMER_PII_BLIND_INDEX_KEY);
const billingTypes = [
  "SUBSCRIPTION_LINK",
  "TRIAL_ENDING_SOON",
  "SUBSCRIPTION_PAYMENT_FAILED",
  "SUBSCRIPTION_CONFIRMED",
];
const containsReference = (value, refs) =>
  typeof value === "string"
    ? refs.has(value)
    : Array.isArray(value)
      ? value.some((item) => containsReference(item, refs))
      : value && typeof value === "object"
        ? Object.values(value).some((item) => containsReference(item, refs))
        : false;
const assertTest = (object) => {
  if (object.deleted || object.livemode !== false)
    throw new Error("Could not prove an external reference belongs to test mode; no changes made.");
};

try {
  if (await prisma.billingTransitionArchive.findUnique({ where: { tenantId } })) {
    console.log(JSON.stringify({ status: "already-transitioned", tenantId }));
  } else {
    const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } });
    if (tenant.status === "CLOSED") throw new Error("Closed organizations are excluded.");
    const subscription = await prisma.subscription.findUnique({ where: { tenantId } });
    const checkout = await prisma.subscriptionCheckoutLink.findUnique({ where: { tenantId } });
    const partner = await prisma.billingoPartner.findUnique({ where: { tenantId } });
    const invoices = await prisma.billingoInvoice.findMany({ where: { tenantId } });
    if (subscription?.plan === "INTERNAL")
      throw new Error("Internal organizations must not be transitioned.");
    if (!subscription?.stripeCustomerId && !checkout && !partner)
      throw new Error("No test billing reference to verify.");
    if (subscription?.stripeCustomerId)
      assertTest(await stripe.customers.retrieve(subscription.stripeCustomerId));
    if (subscription?.stripeSubscriptionId)
      assertTest(await stripe.subscriptions.retrieve(subscription.stripeSubscriptionId));
    if (checkout) assertTest(await stripe.paymentLinks.retrieve(checkout.stripePaymentLinkId));
    if (partner) assertTest(await stripe.customers.retrieve(partner.stripeCustomerId));
    for (const invoice of invoices)
      assertTest(await stripe.invoices.retrieve(invoice.stripeInvoiceId));
    if ((partner || invoices.length) && !args.includes("--confirm-test-billingo"))
      throw new Error(
        "Billingo mappings require --confirm-test-billingo after checking the old Billingo environment.",
      );
    const refs = new Set(
      [
        tenantId,
        subscription?.stripeCustomerId,
        subscription?.stripeSubscriptionId,
        subscription?.stripeScheduleId,
        checkout?.stripePaymentLinkId,
        partner?.stripeCustomerId,
        ...invoices.map((row) => row.stripeInvoiceId),
      ].filter(Boolean),
    );
    const events = await prisma.stripeEvent.findMany({ where: { processedAt: null } });
    const pending = events.filter((row) => containsReference(row.payload, refs));
    if (pending.some((row) => row.payload?.livemode !== false))
      throw new Error(
        "Tenant has pending events not proven test-mode; investigate before cutover.",
      );
    const notifications = await prisma.notification.findMany({
      where: {
        tenantId,
        type: { in: billingTypes },
        status: { in: ["PENDING", "SENDING", "FAILED"] },
      },
    });
    const outbox = await prisma.outboxEvent.findMany({
      where: {
        tenantId,
        eventType: {
          in: [
            "SUBSCRIPTION_LINK_REQUESTED",
            "SUBSCRIPTION_CONFIRMED",
            "SUBSCRIPTION_PAYMENT_FAILED",
            "TRIAL_ENDING_SOON",
          ],
        },
        status: { in: ["PENDING", "PROCESSING", "FAILED"] },
      },
    });
    const snapshot = {
      tenantStatus: tenant.status,
      subscribeBy: tenant.subscribeBy,
      subscription,
      checkout,
      partner,
      invoices,
      eventIds: pending.map((r) => r.id),
      notifications,
      outbox,
    };
    if (apply)
      await prisma.$transaction(
        async (tx) => {
          await tx.billingTransitionArchive.create({
            data: { tenantId, sealedSnapshot: pii.seal(JSON.stringify(snapshot)) },
          });
          await tx.stripeEvent.updateMany({
            where: { id: { in: pending.map((r) => r.id) } },
            data: {
              processedAt: new Date(),
              claimedAt: null,
              lastError: "QUARANTINED_TEST_TO_LIVE",
            },
          });
          await tx.notification.updateMany({
            where: { id: { in: notifications.map((r) => r.id) } },
            data: { status: "SKIPPED", lastError: "QUARANTINED_TEST_TO_LIVE" },
          });
          await tx.outboxEvent.updateMany({
            where: { id: { in: outbox.map((r) => r.id) } },
            data: {
              status: "PROCESSED",
              processedAt: new Date(),
              claimedAt: null,
              lastError: "QUARANTINED_TEST_TO_LIVE",
            },
          });
          await tx.billingoInvoice.deleteMany({ where: { tenantId } });
          await tx.billingoPartner.deleteMany({ where: { tenantId } });
          await tx.subscriptionCheckoutLink.deleteMany({ where: { tenantId } });
          if (subscription)
            await tx.subscription.update({
              where: { tenantId },
              data: {
                status: "CANCELED",
                stripeCustomerId: null,
                stripeSubscriptionId: null,
                stripePriceId: null,
                stripeScheduleId: null,
                currentPeriodEnd: null,
                cancelAtPeriodEnd: false,
                trialEndsAt: null,
                pendingPlan: null,
                pendingPlanStartsAt: null,
                lastStripeStateEventAt: null,
                lastStripeStateEventId: null,
                lastStripeScheduleEventAt: null,
                lastStripeScheduleEventId: null,
                // trialUsedAt deliberately retained.
              },
            });
          await tx.tenant.update({
            where: { id: tenantId },
            data: {
              status: "PENDING_SUBSCRIPTION",
              subscribeBy: new Date(Date.now() + env.ONBOARDING_WINDOW_DAYS * 86400000),
            },
          });
        },
        { isolationLevel: "Serializable", timeout: 30_000 },
      );
    console.log(
      JSON.stringify({
        mode: apply ? "apply" : "dry-run",
        tenantId,
        events: pending.length,
        notifications: notifications.length,
        outbox: outbox.length,
        invoices: invoices.length,
      }),
    );
  }
} finally {
  await prisma.$disconnect();
}
