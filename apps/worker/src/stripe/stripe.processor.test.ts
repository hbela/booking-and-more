import { beforeEach, afterAll, describe, expect, it } from "vitest";
import { createPrismaClient, type PrismaClient } from "@bam/db";
import { createLogger } from "@bam/observability";

import { processStripeEventBatch } from "./stripe.processor.js";

/**
 * Stripe event processing, against a real PostgreSQL.
 * docs/phase-9-subscription-and-activation.md §3.3.
 *
 * Integration rather than unit, for the reason the dispatcher's tests give:
 * the properties worth asserting are the database's. Idempotent activation is
 * enforced by the unique constraint on `subscriptions.tenant_id`, not by an
 * `if` — and a mocked Prisma would happily let a second row through.
 */

const databaseUrl = process.env["TEST_DATABASE_URL"];
const suffix = Math.random().toString(36).slice(2, 10);

const log = createLogger({ service: "stripe-test", level: "silent", pretty: false });

/** What a Stripe payload can contain, which is exactly what Prisma will store. */
type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

describe.skipIf(!databaseUrl)("stripe processor", () => {
  let prisma: PrismaClient;
  let tenantId: string;

  const PRICE_STARTER = `price_starter_${suffix}`;
  const PRICE_PROFESSIONAL = `price_professional_${suffix}`;

  const options = () => ({
    prisma,
    logger: log,
    batchSize: 50,
    planPrices: { STARTER: PRICE_STARTER, PROFESSIONAL: PRICE_PROFESSIONAL },
    orphanTimeoutMs: 900_000,
  });

  /** `items.data[0].price` as Stripe sends it on a subscription. */
  const withPrice = (priceId: string) => ({ items: { data: [{ price: { id: priceId } }] } });

  beforeEach(async () => {
    prisma ??= createPrismaClient({ databaseUrl: databaseUrl! });

    // The processor claims across every tenant, so a leftover row from another
    // test lands in this one's batch.
    await prisma.stripeEvent.deleteMany({});

    const unique = `${suffix}-${Math.random().toString(36).slice(2, 8)}`;

    const tenant = await prisma.tenant.create({
      data: {
        slug: `stripe-${unique}`,
        name: "Stripe Clinic",
        defaultLanguage: "hu",
        status: "PENDING_SUBSCRIPTION",
        subscribeBy: new Date(Date.now() + 14 * 24 * 60 * 60 * 1_000),
      },
    });

    tenantId = tenant.id;
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  /**
   * Store an event shaped the way Stripe sends it — the interesting part
   * nested under `data.object`, which is what `extractObject` unwraps.
   *
   * Typed as JSON rather than `Record<string, unknown>` so it satisfies
   * Prisma's `InputJsonValue` without a cast — `unknown` values do not, and
   * casting around that would only hide the day one of these stops being JSON.
   */
  const record = (id: string, type: string, object: Record<string, Json>) =>
    prisma.stripeEvent.create({
      data: { id: `${id}-${suffix}`, type, payload: { data: { object } } },
    });

  describe("checkout.session.completed", () => {
    it("binds the organization to its Stripe identifiers and clears the deadline", async () => {
      // Suffixed, like every other Stripe id here: `stripe_subscription_id` is
      // unique across the whole table, not per tenant, so a fixed literal
      // collides with the row a previous run of this suite left behind.
      await record("evt_ok", "checkout.session.completed", {
        client_reference_id: tenantId,
        customer: "cus_123",
        subscription: `sub_ok-${suffix}`,
        metadata: { plan: "PROFESSIONAL" },
      });

      const summary = await processStripeEventBatch(options());
      expect(summary).toMatchObject({ processed: 1, failed: 0 });

      const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
      // Left set, the expiry sweep would eventually consider a paying customer.
      expect(tenant?.subscribeBy).toBeNull();

      // Status is deliberately *not* decided here
      // (docs/phase-9-subscription-lifecycle.md §2.1). A trial checkout and a
      // paid one produce an identical session object, and the session does not
      // carry the subscription's status — so TRIAL versus ACTIVE is settled by
      // customer.subscription.*, which does. All this event owes is making the
      // subscription findable, which is what lets those events be attributed.
      expect(tenant?.status).toBe("PENDING_SUBSCRIPTION");

      const subscription = await prisma.subscription.findUnique({ where: { tenantId } });
      expect(subscription?.status).toBe("INCOMPLETE");
      expect(subscription?.stripeSubscriptionId).toBe(`sub_ok-${suffix}`);
      expect(subscription?.stripeCustomerId).toBe("cus_123");
    });

    it("is idempotent — a redelivered completion changes nothing", async () => {
      // Stripe delivers at-least-once, so this happens in production whether or
      // not it is tested. Two subscription rows for one organization would be a
      // billing incident.
      await record("evt_a", "checkout.session.completed", {
        client_reference_id: tenantId,
        subscription: `sub_dupe-${suffix}`,
        metadata: { plan: "STARTER" },
      });
      await processStripeEventBatch(options());

      await record("evt_b", "checkout.session.completed", {
        client_reference_id: tenantId,
        subscription: `sub_dupe-${suffix}`,
        metadata: { plan: "STARTER" },
      });
      const second = await processStripeEventBatch(options());

      expect(second.failed).toBe(0);
      expect(await prisma.subscription.count({ where: { tenantId } })).toBe(1);
    });

    it("does not overwrite a plan the subscription events already resolved", async () => {
      // The session's metadata is the weaker source (§2.4). A redelivery
      // arriving after an upgrade must not drag the plan back to what was
      // bought originally.
      await record("evt_bind", "checkout.session.completed", {
        client_reference_id: tenantId,
        subscription: `sub_keepplan-${suffix}`,
        metadata: { plan: "STARTER" },
      });
      await processStripeEventBatch(options());

      await prisma.subscription.update({
        where: { tenantId },
        data: { plan: "PROFESSIONAL" },
      });

      await record("evt_bind2", "checkout.session.completed", {
        client_reference_id: tenantId,
        subscription: `sub_keepplan-${suffix}`,
        metadata: { plan: "STARTER" },
      });
      await processStripeEventBatch(options());

      expect((await prisma.subscription.findUnique({ where: { tenantId } }))?.plan).toBe(
        "PROFESSIONAL",
      );
    });

    it("fails loudly when the payment cannot be attributed", async () => {
      // Somebody paid and we cannot tell who. Skipping quietly would leave a
      // paying customer gated with no trace of why.
      await record("evt_orphan", "checkout.session.completed", { customer: "cus_x" });

      const summary = await processStripeEventBatch(options());

      expect(summary).toMatchObject({ processed: 0, failed: 1 });

      const stored = await prisma.stripeEvent.findFirst({
        where: { type: "checkout.session.completed" },
      });
      expect(stored?.processedAt).toBeNull();
      expect(stored?.lastError).toContain("client_reference_id");
    });
  });

  describe("customer.subscription.deleted", () => {
    it("suspends the organization and never closes it", async () => {
      // phase-9 §2.6: a former customer's data carries obligations — invoices,
      // bookings taken, their customers' personal data. CLOSED is reserved for
      // prospects who never subscribed at all.
      await prisma.subscription.create({
        data: {
          tenantId,
          plan: "STARTER",
          status: "ACTIVE",
          stripeSubscriptionId: `sub_gone-${suffix}`,
        },
      });
      await prisma.tenant.update({ where: { id: tenantId }, data: { status: "ACTIVE" } });

      await record("evt_del", "customer.subscription.deleted", {
        id: `sub_gone-${suffix}`,
      });

      await processStripeEventBatch(options());

      const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
      expect(tenant?.status).toBe("SUSPENDED");
      expect(tenant?.status).not.toBe("CLOSED");
    });
  });

  describe("customer.subscription.updated", () => {
    it("mirrors status and period end", async () => {
      await prisma.subscription.create({
        data: {
          tenantId,
          plan: "STARTER",
          status: "ACTIVE",
          stripeSubscriptionId: `sub_upd-${suffix}`,
        },
      });

      const periodEnd = Math.floor(Date.now() / 1_000) + 30 * 24 * 60 * 60;

      await record("evt_upd", "customer.subscription.updated", {
        id: `sub_upd-${suffix}`,
        status: "past_due",
        cancel_at_period_end: true,
        current_period_end: periodEnd,
      });

      await processStripeEventBatch(options());

      const subscription = await prisma.subscription.findUnique({ where: { tenantId } });
      expect(subscription?.status).toBe("PAST_DUE");
      expect(subscription?.cancelAtPeriodEnd).toBe(true);
      expect(subscription?.currentPeriodEnd?.getTime()).toBe(periodEnd * 1_000);
    });

    /**
     * The grace period, which is Stripe's rather than ours.
     * docs/phase-9-subscription-lifecycle.md §2.3.
     *
     * A declined renewal must not lock the customer out: Stripe is still
     * retrying, and when it gives up it cancels, which arrives as
     * `deleted` and suspends through the test above. Suspending here would
     * revoke access on the first failed attempt — usually an expired card,
     * usually fixed within a day.
     */
    it("does not suspend on past_due — dunning is the grace period", async () => {
      await prisma.subscription.create({
        data: {
          tenantId,
          plan: "STARTER",
          status: "ACTIVE",
          stripeSubscriptionId: `sub_grace-${suffix}`,
        },
      });
      await prisma.tenant.update({ where: { id: tenantId }, data: { status: "ACTIVE" } });

      await record("evt_grace", "customer.subscription.updated", {
        id: `sub_grace-${suffix}`,
        status: "past_due",
      });

      await processStripeEventBatch(options());

      expect((await prisma.tenant.findUnique({ where: { id: tenantId } }))?.status).toBe("ACTIVE");
    });

    /**
     * The other half of §3's refusal: nothing here lifts a tenant out of
     * SUSPENDED. It has two causes — Stripe cancelled, or a platform admin
     * intervened — and the row does not record which, so reactivating on a
     * Stripe event would silently reverse an operator's suspension.
     */
    it("never reactivates a suspended organization", async () => {
      await prisma.subscription.create({
        data: {
          tenantId,
          plan: "STARTER",
          status: "CANCELED",
          stripeSubscriptionId: `sub_susp-${suffix}`,
        },
      });
      await prisma.tenant.update({ where: { id: tenantId }, data: { status: "SUSPENDED" } });

      await record("evt_revive", "customer.subscription.updated", {
        id: `sub_susp-${suffix}`,
        status: "active",
        ...withPrice(PRICE_STARTER),
      });

      await processStripeEventBatch(options());

      const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
      expect(tenant?.status).toBe("SUSPENDED");
      // The subscription itself still mirrors — only the tenant is protected.
      expect((await prisma.subscription.findUnique({ where: { tenantId } }))?.status).toBe(
        "ACTIVE",
      );
    });

    /**
     * The portal's cancellation, in the billing mode Stripe now defaults to.
     * docs/phase-9-customer-portal.md §3.1.
     *
     * Flexible mode leaves `cancel_at_period_end` false and sets `cancel_at`.
     * Reading only the boolean fails silently and completely: the owner
     * cancels, Stripe agrees, and the screen goes on saying "renews on" until
     * the organization is suspended without warning.
     */
    it("sees a cancellation that says cancel_at rather than cancel_at_period_end", async () => {
      await prisma.subscription.create({
        data: {
          tenantId,
          plan: "STARTER",
          status: "ACTIVE",
          stripeSubscriptionId: `sub_flex-${suffix}`,
        },
      });

      await record("evt_flex", "customer.subscription.updated", {
        id: `sub_flex-${suffix}`,
        status: "active",
        cancel_at_period_end: false,
        cancel_at: Math.floor(Date.now() / 1_000) + 20 * 24 * 60 * 60,
      });

      await processStripeEventBatch(options());

      expect((await prisma.subscription.findUnique({ where: { tenantId } }))?.cancelAtPeriodEnd).toBe(
        true,
      );
    });

    it("mirrors a plan switched in the portal, from the price's metadata", async () => {
      await prisma.subscription.create({
        data: {
          tenantId,
          plan: "STARTER",
          status: "ACTIVE",
          stripeSubscriptionId: `sub_up-${suffix}`,
        },
      });

      await record("evt_up", "customer.subscription.updated", {
        id: `sub_up-${suffix}`,
        status: "active",
        items: { data: [{ price: { metadata: { plan: "PROFESSIONAL" } } }] },
      });

      await processStripeEventBatch(options());

      expect((await prisma.subscription.findUnique({ where: { tenantId } }))?.plan).toBe(
        "PROFESSIONAL",
      );
    });

    /**
     * The asymmetry with `planFromMetadata`, asserted (§3.2).
     *
     * Activation falls back to STARTER because a customer who has paid must end
     * up active. Here there is already a plan that was right a moment ago, and
     * the same fallback would silently downgrade a customer who had just
     * upgraded — then keep doing it on every unrelated update afterwards.
     */
    it("leaves the plan alone when the event does not name one", async () => {
      await prisma.subscription.create({
        data: {
          tenantId,
          plan: "PROFESSIONAL",
          status: "ACTIVE",
          stripeSubscriptionId: `sub_keep-${suffix}`,
        },
      });

      await record("evt_keep", "customer.subscription.updated", {
        id: `sub_keep-${suffix}`,
        status: "active",
      });

      await processStripeEventBatch(options());

      expect((await prisma.subscription.findUnique({ where: { tenantId } }))?.plan).toBe(
        "PROFESSIONAL",
      );
    });

    it("refuses a status nobody has considered rather than storing it", async () => {
      // phase-9 §2.7: the predecessor kept Stripe's status as free text, so an
      // unrecognised value sat in the column being quietly wrong.
      await prisma.subscription.create({
        data: {
          tenantId,
          plan: "STARTER",
          status: "ACTIVE",
          stripeSubscriptionId: `sub_weird-${suffix}`,
        },
      });

      await record("evt_weird", "customer.subscription.updated", {
        id: `sub_weird-${suffix}`,
        status: "paused_for_reasons",
      });

      const summary = await processStripeEventBatch(options());

      expect(summary).toMatchObject({ processed: 0, failed: 1 });
      expect((await prisma.subscription.findUnique({ where: { tenantId } }))?.status).toBe(
        "ACTIVE",
      );
    });
  });

  describe("the free trial", () => {
    /** A subscription bound by checkout, awaiting its first status event. */
    const bind = async (subscriptionId: string) => {
      await prisma.subscription.create({
        data: { tenantId, plan: "STARTER", status: "INCOMPLETE", stripeSubscriptionId: subscriptionId },
      });
    };

    it("puts the organization in TRIAL and stamps the trial as used", async () => {
      const trialEnd = Math.floor(Date.now() / 1_000) + 30 * 24 * 60 * 60;
      await bind(`sub_trial-${suffix}`);

      await record("evt_trial", "customer.subscription.created", {
        id: `sub_trial-${suffix}`,
        status: "trialing",
        trial_end: trialEnd,
        ...withPrice(PRICE_STARTER),
      });

      await processStripeEventBatch(options());

      const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
      // TRIAL, not ACTIVE. The enum reserved this value for a real free trial
      // and nothing reached it until now — and `tenantAcceptsWrites` already
      // allows it, so the owner can configure their clinic during the trial.
      expect(tenant?.status).toBe("TRIAL");
      expect(tenant?.subscribeBy).toBeNull();

      const subscription = await prisma.subscription.findUnique({ where: { tenantId } });
      expect(subscription?.status).toBe("TRIALING");
      expect(subscription?.trialEndsAt?.getTime()).toBe(trialEnd * 1_000);
      expect(subscription?.trialUsedAt).not.toBeNull();
      // Resolved from the price, not from metadata — there is none here (§2.4).
      expect(subscription?.plan).toBe("STARTER");
      expect(subscription?.stripePriceId).toBe(PRICE_STARTER);
    });

    /**
     * The gate that stops a second free month.
     *
     * `trialUsedAt` is what `requestPaymentLink` reads to choose between the
     * trial and no-trial Payment Link, so refreshing it on a redelivery — or on
     * a later trial Stripe might grant — would hand out the trial again.
     */
    it("never moves trialUsedAt once it is set", async () => {
      await bind(`sub_once-${suffix}`);

      await record("evt_t1", "customer.subscription.created", {
        id: `sub_once-${suffix}`,
        status: "trialing",
        ...withPrice(PRICE_STARTER),
      });
      await processStripeEventBatch(options());

      const first = await prisma.subscription.findUnique({ where: { tenantId } });

      await record("evt_t2", "customer.subscription.updated", {
        id: `sub_once-${suffix}`,
        status: "trialing",
        ...withPrice(PRICE_STARTER),
      });
      await processStripeEventBatch(options());

      const second = await prisma.subscription.findUnique({ where: { tenantId } });
      expect(second?.trialUsedAt?.getTime()).toBe(first?.trialUsedAt?.getTime());
    });

    it("converts to ACTIVE when the first charge succeeds", async () => {
      await bind(`sub_conv-${suffix}`);

      await record("evt_c1", "customer.subscription.created", {
        id: `sub_conv-${suffix}`,
        status: "trialing",
        ...withPrice(PRICE_STARTER),
      });
      await processStripeEventBatch(options());

      await record("evt_c2", "customer.subscription.updated", {
        id: `sub_conv-${suffix}`,
        status: "active",
        ...withPrice(PRICE_STARTER),
      });
      await processStripeEventBatch(options());

      expect((await prisma.tenant.findUnique({ where: { id: tenantId } }))?.status).toBe("ACTIVE");
      // Still stamped, so a later resubscribe gets the no-trial link.
      expect(
        (await prisma.subscription.findUnique({ where: { tenantId } }))?.trialUsedAt,
      ).not.toBeNull();
    });

    it("asks for a warning email when the trial is about to end", async () => {
      await bind(`sub_warn-${suffix}`);

      await record("evt_warn", "customer.subscription.trial_will_end", {
        id: `sub_warn-${suffix}`,
        trial_end: Math.floor(Date.now() / 1_000) + 3 * 24 * 60 * 60,
      });

      const summary = await processStripeEventBatch(options());
      expect(summary).toMatchObject({ processed: 1, failed: 0 });

      // Requested, not sent. A Resend outage must retry the email rather than
      // fail the Stripe event and replay the whole thing (tech-impl §12).
      const events = await prisma.outboxEvent.findMany({
        where: { tenantId, eventType: "TRIAL_ENDING_SOON" },
      });
      expect(events).toHaveLength(1);
    });
  });

  describe("out-of-order delivery", () => {
    /**
     * The guide's test #15, which this integration used to fail silently.
     * docs/phase-9-subscription-lifecycle.md §4.
     *
     * `customer.subscription.created` carries no `client_reference_id`, so
     * before `checkout.session.completed` has run there is nothing to attribute
     * it to. It used to be logged and dropped; now it retries.
     */
    it("retries an event whose subscription has not been bound yet", async () => {
      await record("evt_early", "customer.subscription.created", {
        id: `sub_early-${suffix}`,
        status: "trialing",
        ...withPrice(PRICE_STARTER),
      });

      const first = await processStripeEventBatch(options());
      expect(first).toMatchObject({ processed: 0, failed: 1 });

      // The sibling arrives, as it does within seconds in practice.
      await prisma.subscription.create({
        data: {
          tenantId,
          plan: "STARTER",
          status: "INCOMPLETE",
          stripeSubscriptionId: `sub_early-${suffix}`,
        },
      });

      const second = await processStripeEventBatch(options());
      expect(second).toMatchObject({ processed: 1, failed: 0 });
      expect((await prisma.tenant.findUnique({ where: { id: tenantId } }))?.status).toBe("TRIAL");
    });

    it("gives up on an event that stays unattributable", async () => {
      // Somebody else's subscription, or one made by hand in the dashboard.
      // Retrying forever would fill the table with permanent failures.
      await record("evt_foreign", "customer.subscription.updated", {
        id: `sub_foreign-${suffix}`,
        status: "active",
      });

      const summary = await processStripeEventBatch({ ...options(), orphanTimeoutMs: 0 });

      expect(summary).toMatchObject({ processed: 1, failed: 0 });
      expect(
        (await prisma.stripeEvent.findFirst({ where: { type: "customer.subscription.updated" } }))
          ?.processedAt,
      ).not.toBeNull();
    });
  });

  describe("scheduled plan changes", () => {
    const startsAt = Math.floor(Date.now() / 1_000) + 20 * 24 * 60 * 60;

    // Regenerated per test, not shared across the block. `stripe_subscription_id`
    // is unique across the whole table rather than per tenant, so a literal
    // reused by three tests collides on the second — the same trap recorded in
    // phase-9-subscription-and-activation.md §8.2, which caught this suite
    // once already.
    let subId: string;
    let scheduleId: string;

    beforeEach(async () => {
      const unique = `${suffix}-${Math.random().toString(36).slice(2, 8)}`;
      subId = `sub_sched-${unique}`;
      scheduleId = `sub_sched_obj-${unique}`;

      await prisma.subscription.create({
        data: {
          tenantId,
          plan: "PROFESSIONAL",
          status: "ACTIVE",
          stripeSubscriptionId: subId,
        },
      });
    });

    /**
     * A downgrade does not change the subscription — Stripe attaches a schedule
     * whose next phase carries the new price. Without mirroring it the owner
     * sees the plan they are leaving and no sign that they left it (§2.4).
     */
    it("records the plan the subscription becomes, and when", async () => {
      await record("evt_sched", "subscription_schedule.created", {
        id: scheduleId,
        subscription: subId,
        phases: [
          { start_date: Math.floor(Date.now() / 1_000) - 60, items: [{ price: PRICE_PROFESSIONAL }] },
          { start_date: startsAt, items: [{ price: PRICE_STARTER }] },
        ],
      });

      await processStripeEventBatch(options());

      const subscription = await prisma.subscription.findUnique({ where: { tenantId } });
      // Still on Professional, which is what they are paying for.
      expect(subscription?.plan).toBe("PROFESSIONAL");
      expect(subscription?.pendingPlan).toBe("STARTER");
      expect(subscription?.pendingPlanStartsAt?.getTime()).toBe(startsAt * 1_000);
      expect(subscription?.stripeScheduleId).toBe(scheduleId);
    });

    it("clears the pending plan when the schedule is released", async () => {
      await prisma.subscription.update({
        where: { tenantId },
        data: {
          stripeScheduleId: scheduleId,
          pendingPlan: "STARTER",
          pendingPlanStartsAt: new Date(startsAt * 1_000),
        },
      });

      await record("evt_rel", "subscription_schedule.released", {
        id: scheduleId,
        subscription: subId,
      });

      await processStripeEventBatch(options());

      const subscription = await prisma.subscription.findUnique({ where: { tenantId } });
      expect(subscription?.pendingPlan).toBeNull();
      expect(subscription?.pendingPlanStartsAt).toBeNull();
      expect(subscription?.stripeScheduleId).toBeNull();
    });

    it("clears the pending plan once the subscription actually reaches it", async () => {
      await prisma.subscription.update({
        where: { tenantId },
        data: { pendingPlan: "STARTER", pendingPlanStartsAt: new Date(startsAt * 1_000) },
      });

      await record("evt_landed", "customer.subscription.updated", {
        id: subId,
        status: "active",
        ...withPrice(PRICE_STARTER),
      });

      await processStripeEventBatch(options());

      const subscription = await prisma.subscription.findUnique({ where: { tenantId } });
      expect(subscription?.plan).toBe("STARTER");
      expect(subscription?.pendingPlan).toBeNull();
    });
  });

  describe("invoice.payment_failed", () => {
    it("asks for an email without touching access", async () => {
      await prisma.subscription.create({
        data: {
          tenantId,
          plan: "STARTER",
          status: "ACTIVE",
          stripeSubscriptionId: `sub_fail-${suffix}`,
        },
      });
      await prisma.tenant.update({ where: { id: tenantId }, data: { status: "ACTIVE" } });

      await record("evt_fail", "invoice.payment_failed", {
        subscription: `sub_fail-${suffix}`,
        amount_due: 15_000,
        currency: "huf",
      });

      await processStripeEventBatch(options());

      expect(
        await prisma.outboxEvent.count({
          where: { tenantId, eventType: "SUBSCRIPTION_PAYMENT_FAILED" },
        }),
      ).toBe(1);
      // Access is Stripe's dunning to revoke, not this event's (§2.3).
      expect((await prisma.tenant.findUnique({ where: { id: tenantId } }))?.status).toBe("ACTIVE");
    });
  });

  it("marks event types it does not act on as processed", async () => {
    // Retrying them would fill the table with permanent failures; Stripe sends
    // far more types than any account acts on.
    await record("evt_noise", "invoice.created", { id: "in_1" });

    const summary = await processStripeEventBatch(options());

    expect(summary).toMatchObject({ processed: 1, failed: 0 });
    expect(
      (await prisma.stripeEvent.findFirst({ where: { type: "invoice.created" } }))?.processedAt,
    ).not.toBeNull();
  });
});
