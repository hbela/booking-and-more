import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadEnv } from "@bam/config";

import { buildApp, type AppInstance } from "./app.js";
import { BillingService } from "./modules/billing/billing.service.js";

/**
 * Billing. docs/phase-9-subscription-and-activation.md §3.
 *
 * The first test in this file is the important one, and it is the reason the
 * file exists at all. phase-9 §2.4 calls the write-gate exemption "the single
 * most important implementation detail in this document": subscribing is itself
 * a write, so a billing route behind `requireWritableTenant` leaves a pending
 * owner unable to subscribe, unable to leave PENDING_SUBSCRIPTION, and watching
 * their organization expire while they try to pay for it.
 *
 * The exemption is expressed by *not* registering a guard, which nothing
 * enforces. This test is the enforcement.
 */

const databaseUrl = process.env["TEST_DATABASE_URL"];

const RUN = `bil${randomBytes(4).toString("hex")}`;
const PASSWORD = "correct-horse-battery-staple";
const STARTER_PRICE = "price_test_starter";

/**
 * A stand-in for Stripe's payment-link API.
 *
 * Selling a subscription makes a real API call since
 * docs/phase-9-duplicate-subscription-prevention.md §4.1, so the suite needs a
 * seam. It records every call, which is most of what these tests assert: how
 * many links were created for one organization is the question the whole slice
 * is about.
 */
function stubPaymentLinks() {
  const created: {
    priceId: string;
    tenantId: string;
    plan: string;
    trialPeriodDays: number | null;
    returnUrl: string;
  }[] = [];
  const deactivated: string[] = [];
  /** Link IDs the fake Stripe considers already checked out. */
  const completed = new Set<string>();
  let next = 0;

  return {
    created,
    deactivated,
    completed,
    client: {
      create: async (input: {
        priceId: string;
        tenantId: string;
        plan: string;
        trialPeriodDays: number | null;
        returnUrl: string;
      }) => {
        created.push(input);
        next += 1;

        // Suffixed with the run, like every other Stripe id in this suite:
        // `stripe_payment_link_id` is unique across the whole table, not per
        // tenant, so a counter alone collides with the rows the previous run
        // left behind — and the collision surfaces as a 500 from the P2002
        // path, which is the least obvious symptom it could have.
        return {
          id: `plink_${RUN}_${next}`,
          url: `https://buy.stripe.com/test_${RUN}_${next}`,
        };
      },
      deactivate: async (id: string) => {
        deactivated.push(id);
      },
      hasCompletedCheckout: async (id: string) => completed.has(id),
    },
  };
}

describe.skipIf(!databaseUrl)("billing", () => {
  let app: AppInstance;
  let stripe: ReturnType<typeof stubPaymentLinks>;

  beforeAll(async () => {
    const env = loadEnv({
      source: {
        NODE_ENV: "test",
        LOG_LEVEL: "silent",
        APP_BASE_URL: "http://localhost:3000",
        API_BASE_URL: "http://localhost:3001",
        DATABASE_URL: databaseUrl!,
        BETTER_AUTH_SECRET: "test-secret-that-is-at-least-32-characters-long",
        // STARTER only, deliberately: "a plan with no price is not for sale" is
        // asserted below, and it needs a plan that has none. Legal because the
        // superRefine only demands both prices alongside a secret key, and this
        // app has no key — the payment-link client is injected instead.
        STRIPE_PRICE_STARTER: STARTER_PRICE,
      },
      loadDotenvFile: false,
    });

    stripe = stubPaymentLinks();

    app = await buildApp({
      env,
      logger: false,
      rateLimit: false,
      paymentLinkClient: stripe.client,
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  function cookiesFrom(headers: { "set-cookie"?: string | string[] | undefined }): string {
    const setCookie = headers["set-cookie"];
    const cookies: string[] = Array.isArray(setCookie) ? setCookie : [setCookie ?? ""];

    return cookies
      .map((entry) => entry.split(";")[0] ?? "")
      .filter(Boolean)
      .join("; ");
  }

  /**
   * A pending organization with a signed-in owner — the exact state this whole
   * slice is about. Built through the real routes rather than by inserting
   * rows, so the test breaks if provisioning or acceptance breaks.
   */
  async function pendingOwner(
    label: string,
    /**
     * The organization's language. Left out it is `hu`, the schema's default —
     * which is what every caller here wants and, until
     * docs/phase-9-owner-language-and-return-paths.md §3, was the only value
     * reachable through the platform form.
     */
    defaultLanguage?: "hu" | "en",
  ): Promise<{ cookie: string; tenantId: string; email: string }> {
    const adminEmail = `op-${label}-${RUN}@example.test`;

    const adminSignUp = await app.inject({
      method: "POST",
      url: "/v1/auth/sign-up/email",
      payload: { email: adminEmail, password: PASSWORD, name: "Operator" },
    });
    expect(adminSignUp.statusCode).toBeLessThan(400);

    await app.prisma.user.update({
      where: { email: adminEmail },
      data: { isPlatformAdmin: true },
    });

    const adminSignIn = await app.inject({
      method: "POST",
      url: "/v1/auth/sign-in/email",
      payload: { email: adminEmail, password: PASSWORD },
    });

    const ownerEmail = `owner-${label}-${RUN}@example.test`;

    const provisioned = await app.inject({
      method: "POST",
      url: "/v1/platform/organizations",
      headers: { cookie: cookiesFrom(adminSignIn.headers) },
      payload: {
        name: "Wellness Studio",
        slug: `${label}-${RUN}`,
        domain: `${label}-${RUN}.hu`,
        ownerName: "Kovács Anna",
        ownerEmail,
        ...(defaultLanguage === undefined ? {} : { defaultLanguage }),
      },
    });
    expect(provisioned.statusCode, provisioned.body).toBe(201);

    const body = provisioned.json<{ acceptUrl: string; organization: { id: string } }>();
    const token = body.acceptUrl.split("/invitations/")[1] ?? "";

    const registered = await app.inject({
      method: "POST",
      url: "/v1/invitations/accept-and-register",
      payload: { token, name: "Kovács Anna", password: PASSWORD },
    });
    expect(registered.statusCode, registered.body).toBe(201);

    return {
      cookie: cookiesFrom(registered.headers),
      tenantId: body.organization.id,
      email: ownerEmail,
    };
  }

  describe("the activation gate", () => {
    it("lets a pending owner subscribe but not configure anything", async () => {
      // Both halves in one test on purpose: they are one property, and split
      // apart it is possible for the suite to stay green while the product is
      // broken in exactly the way §2.4 warns about.
      const owner = await pendingOwner("gate");

      const tenant = await app.prisma.tenant.findUnique({ where: { id: owner.tenantId } });
      expect(tenant?.status).toBe("PENDING_SUBSCRIPTION");

      const subscribe = await app.inject({
        method: "POST",
        url: "/v1/billing/subscribe",
        headers: { cookie: owner.cookie, "x-tenant-id": owner.tenantId },
        payload: { plan: "STARTER" },
      });

      expect(
        subscribe.statusCode,
        `a pending owner must be able to subscribe — this is the bug §2.4 exists to prevent: ${subscribe.body}`,
      ).toBe(201);

      const createService = await app.inject({
        method: "POST",
        url: "/v1/services",
        headers: { cookie: owner.cookie, "x-tenant-id": owner.tenantId },
        payload: { name: "Consultation", durationMinutes: 30 },
      });

      expect(createService.statusCode).toBe(403);
    });
  });

  describe("subscribe", () => {
    it("returns a payment link carrying the tenant, and queues the email", async () => {
      const owner = await pendingOwner("link");

      const response = await app.inject({
        method: "POST",
        url: "/v1/billing/subscribe",
        headers: { cookie: owner.cookie, "x-tenant-id": owner.tenantId },
        payload: { plan: "STARTER" },
      });

      expect(response.statusCode).toBe(201);

      const body = response.json<{ paymentUrl: string; emailedTo: string }>();
      const url = new URL(body.paymentUrl);

      // Still the join key the checkout session carries back (§3.2), even
      // though the link now also stamps `metadata.tenantId` on the subscription.
      expect(url.searchParams.get("client_reference_id")).toBe(owner.tenantId);
      expect(body.emailedTo).toBe(owner.email);

      // Created for this organization alone, and limited by Stripe to one
      // completed session (docs/phase-9-duplicate-subscription-prevention.md
      // §4.1). The limit lives in stripe.client.ts and is asserted there; what
      // matters here is that the link is per-tenant at all.
      const link = stripe.created.at(-1);
      expect(link).toMatchObject({ tenantId: owner.tenantId, priceId: STARTER_PRICE });
      // Never had a trial, so Stripe is told to give one.
      expect(link?.trialPeriodDays).toBe(30);

      // Paying brings them back to the product rather than ending on Stripe's
      // confirmation page (docs/phase-9-owner-language-and-return-paths.md
      // §4.1). Hungarian, so no locale prefix.
      expect(link?.returnUrl).toBe("http://localhost:3000/dashboard/subscription");

      // Requested, not sent — a third-party call inside this request is how the
      // predecessor swallowed delivery failures.
      const events = await app.prisma.outboxEvent.findMany({
        where: { tenantId: owner.tenantId, eventType: "SUBSCRIPTION_LINK_REQUESTED" },
      });
      expect(events).toHaveLength(1);
    });

    it("sends an English organization back to its English screen after paying", async () => {
      // The prefix is the whole assertion. It is baked into the link at
      // creation, which is only sound because a link belongs to one
      // organization (docs/phase-9-duplicate-subscription-prevention.md §4.1) —
      // under the shared-link design there would have been no right answer.
      const owner = await pendingOwner("linken", "en");

      const response = await app.inject({
        method: "POST",
        url: "/v1/billing/subscribe",
        headers: { cookie: owner.cookie, "x-tenant-id": owner.tenantId },
        payload: { plan: "STARTER" },
      });

      expect(response.statusCode).toBe(201);
      expect(stripe.created.at(-1)?.returnUrl).toBe(
        "http://localhost:3000/en/dashboard/subscription",
      );
    });

    it("refuses a plan with no price configured", async () => {
      // PROFESSIONAL has no price in this app's config, so no link can be built
      // for it and it is not for sale.
      const owner = await pendingOwner("noplan");

      const response = await app.inject({
        method: "POST",
        url: "/v1/billing/subscribe",
        headers: { cookie: owner.cookie, "x-tenant-id": owner.tenantId },
        payload: { plan: "PROFESSIONAL" },
      });

      expect(response.statusCode).toBe(404);
    });

    it("refuses INTERNAL, which is not for sale at any price", async () => {
      const owner = await pendingOwner("internal");

      const response = await app.inject({
        method: "POST",
        url: "/v1/billing/subscribe",
        headers: { cookie: owner.cookie, "x-tenant-id": owner.tenantId },
        payload: { plan: "INTERNAL" },
      });

      expect(response.statusCode).toBe(422);
    });

    it("refuses an organization that already has a subscription", async () => {
      // What stops a double-clicked button billing twice (§2.7).
      const owner = await pendingOwner("dup");

      await app.prisma.subscription.create({
        data: { tenantId: owner.tenantId, plan: "STARTER", status: "ACTIVE" },
      });

      const response = await app.inject({
        method: "POST",
        url: "/v1/billing/subscribe",
        headers: { cookie: owner.cookie, "x-tenant-id": owner.tenantId },
        payload: { plan: "STARTER" },
      });

      expect(response.statusCode).toBe(409);
    });

    /**
     * The incident, reproduced.
     * docs/phase-9-duplicate-subscription-prevention.md §1.
     *
     * The old guard read the local `subscriptions` row, which the worker writes
     * when `checkout.session.completed` is processed — so it asked the payment
     * path whether the payment path had finished. With no webhook processed at
     * all, as here, it answered "no" every time and vended a fresh link on every
     * click. One tenant reached three live Stripe subscriptions that way.
     */
    it("hands back the same link rather than minting a second one", async () => {
      const owner = await pendingOwner("oncelink");
      const before = stripe.created.length;

      const first = await app.inject({
        method: "POST",
        url: "/v1/billing/subscribe",
        headers: { cookie: owner.cookie, "x-tenant-id": owner.tenantId },
        payload: { plan: "STARTER" },
      });
      const second = await app.inject({
        method: "POST",
        url: "/v1/billing/subscribe",
        headers: { cookie: owner.cookie, "x-tenant-id": owner.tenantId },
        payload: { plan: "STARTER" },
      });

      expect(first.statusCode).toBe(201);
      expect(second.statusCode, second.body).toBe(201);

      // Not merely equivalent URLs — the identical one. A regenerated link that
      // looks the same is a second link as far as Stripe is concerned, with its
      // own allowance of one completed session.
      expect(second.json<{ paymentUrl: string }>().paymentUrl).toBe(
        first.json<{ paymentUrl: string }>().paymentUrl,
      );

      // The assertion that would have caught the incident: one link exists, so
      // Stripe's per-link limit of one completed session is a limit of one
      // payment.
      expect(stripe.created.length - before).toBe(1);
      expect(
        await app.prisma.subscriptionCheckoutLink.count({ where: { tenantId: owner.tenantId } }),
      ).toBe(1);
    });

    /**
     * The other half of §2.1: nothing local knows they have paid yet.
     *
     * No Stripe event has been recorded, so every row we own still says this
     * organization has no subscription. The refusal comes from asking Stripe
     * whether the link has been checked out — a *list*, strongly consistent,
     * with none of `subscriptions.search`'s "up to an hour behind" caveat (§3.1).
     */
    it("refuses a second attempt once Stripe says the link was used, webhook or not", async () => {
      const owner = await pendingOwner("paidalready");

      const first = await app.inject({
        method: "POST",
        url: "/v1/billing/subscribe",
        headers: { cookie: owner.cookie, "x-tenant-id": owner.tenantId },
        payload: { plan: "STARTER" },
      });
      expect(first.statusCode).toBe(201);

      const link = await app.prisma.subscriptionCheckoutLink.findUniqueOrThrow({
        where: { tenantId: owner.tenantId },
      });

      // They pay. Stripe knows; we do not — no webhook, no worker, no rows.
      stripe.completed.add(link.stripePaymentLinkId);

      const second = await app.inject({
        method: "POST",
        url: "/v1/billing/subscribe",
        headers: { cookie: owner.cookie, "x-tenant-id": owner.tenantId },
        payload: { plan: "STARTER" },
      });

      expect(second.statusCode, second.body).toBe(409);

      // Still nothing mirrored locally — proving the refusal came from Stripe
      // and not from a row that happened to arrive in time.
      expect(await app.prisma.subscription.count({ where: { tenantId: owner.tenantId } })).toBe(0);

      // Learned once and remembered, so the next attempt costs no API call.
      const after = await app.prisma.subscriptionCheckoutLink.findUniqueOrThrow({
        where: { tenantId: owner.tenantId },
      });
      expect(after.consumedAt).not.toBeNull();
    });

    it("replaces the link when the owner changes plan before paying", async () => {
      const owner = await pendingOwner("switch");

      // This app sells STARTER only, so the swap is asserted the other way
      // round: a second request for the *same* plan must not deactivate
      // anything, which is the regression that would make every double-click
      // burn a link.
      await app.inject({
        method: "POST",
        url: "/v1/billing/subscribe",
        headers: { cookie: owner.cookie, "x-tenant-id": owner.tenantId },
        payload: { plan: "STARTER" },
      });

      const link = await app.prisma.subscriptionCheckoutLink.findUniqueOrThrow({
        where: { tenantId: owner.tenantId },
      });

      await app.inject({
        method: "POST",
        url: "/v1/billing/subscribe",
        headers: { cookie: owner.cookie, "x-tenant-id": owner.tenantId },
        payload: { plan: "STARTER" },
      });

      expect(stripe.deactivated).not.toContain(link.stripePaymentLinkId);
    });

    it("refuses a checkout that completed but has only reached us as an id", async () => {
      // The INCOMPLETE hole (§2.1). `activate()` writes the row as INCOMPLETE,
      // which `isLiveSubscription` correctly calls not-live — so a status test
      // alone stayed open until `customer.subscription.created` had *also* been
      // processed. Any Stripe subscription id at all means somebody paid.
      const owner = await pendingOwner("incomplete");

      await app.prisma.subscription.create({
        data: {
          tenantId: owner.tenantId,
          plan: "STARTER",
          status: "INCOMPLETE",
          stripeSubscriptionId: `sub_incomplete_${RUN}`,
        },
      });

      const response = await app.inject({
        method: "POST",
        url: "/v1/billing/subscribe",
        headers: { cookie: owner.cookie, "x-tenant-id": owner.tenantId },
        payload: { plan: "STARTER" },
      });

      expect(response.statusCode, response.body).toBe(409);
    });

    it("offers only the plans that can actually be paid for", async () => {
      const owner = await pendingOwner("plans");

      const response = await app.inject({
        method: "GET",
        url: "/v1/billing/subscription",
        headers: { cookie: owner.cookie, "x-tenant-id": owner.tenantId },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json<{ availablePlans: string[] }>().availablePlans).toEqual(["STARTER"]);
      expect(response.json<{ subscription: unknown }>().subscription).toBeNull();
      // Never subscribed, so the screen may promise a free trial.
      expect(response.json<{ trialAvailable: boolean }>().trialAvailable).toBe(true);
    });
  });

  describe("the free trial", () => {
    // docs/phase-9-subscription-lifecycle.md §2.1, as amended by
    // docs/phase-9-duplicate-subscription-prevention.md §4.2. The trial used to
    // be a property of a link created once per plan, so "skip the trial for a
    // returning customer" needed a second configured URL and *which link was
    // sent* was the only observable proof. A link created per organization
    // carries `subscription_data.trial_period_days`, so the proof is now what
    // Stripe was told.
    it("gives an organization that has never subscribed its free days", async () => {
      const owner = await pendingOwner("trialnew");

      const response = await app.inject({
        method: "POST",
        url: "/v1/billing/subscribe",
        headers: { cookie: owner.cookie, "x-tenant-id": owner.tenantId },
        payload: { plan: "STARTER" },
      });

      expect(response.statusCode).toBe(201);
      expect(response.json<{ trial: boolean }>().trial).toBe(true);
      expect(stripe.created.at(-1)?.trialPeriodDays).toBe(30);
    });

    /**
     * The returning customer, and the reason `trialUsedAt` lives on a row that
     * survives cancellation.
     *
     * They are allowed to come back. What they are not allowed is another
     * thirty free days — so the link is created with no trial at all rather
     * than with a different URL.
     */
    it("gives none to one that has already used its trial", async () => {
      const owner = await pendingOwner("trialused");

      await app.prisma.subscription.create({
        data: {
          tenantId: owner.tenantId,
          plan: "STARTER",
          status: "CANCELED",
          trialUsedAt: new Date("2026-01-01T00:00:00.000Z"),
        },
      });

      const response = await app.inject({
        method: "POST",
        url: "/v1/billing/subscribe",
        headers: { cookie: owner.cookie, "x-tenant-id": owner.tenantId },
        payload: { plan: "STARTER" },
      });

      expect(response.statusCode, response.body).toBe(201);

      const body = response.json<{ paymentUrl: string; trial: boolean }>();

      expect(body.trial).toBe(false);
      expect(stripe.created.at(-1)?.trialPeriodDays).toBeNull();
      // Still carries the tenant: the join key matters just as much second time.
      expect(new URL(body.paymentUrl).searchParams.get("client_reference_id")).toBe(owner.tenantId);
    });

    it("tells the screen the trial is gone, so it stops promising one", async () => {
      const owner = await pendingOwner("trialflag");

      await app.prisma.subscription.create({
        data: {
          tenantId: owner.tenantId,
          plan: "STARTER",
          status: "CANCELED",
          trialUsedAt: new Date("2026-01-01T00:00:00.000Z"),
        },
      });

      const response = await app.inject({
        method: "GET",
        url: "/v1/billing/subscription",
        headers: { cookie: owner.cookie, "x-tenant-id": owner.tenantId },
      });

      expect(response.json<{ trialAvailable: boolean }>().trialAvailable).toBe(false);
    });
  });

  describe("the customer portal", () => {
    // docs/phase-9-customer-portal.md. This app is built without
    // STRIPE_SECRET_KEY, so the route is registered but has no way to create a
    // session — which is the unconfigured half of §2.1.
    it("reports unavailable rather than absent when Stripe is unconfigured", async () => {
      const owner = await pendingOwner("portalcfg");

      // Subscribed, so the 409 below cannot be what answers.
      await app.prisma.subscription.create({
        data: {
          tenantId: owner.tenantId,
          plan: "STARTER",
          status: "ACTIVE",
          stripeCustomerId: `cus_portalcfg-${RUN}`,
        },
      });

      const response = await app.inject({
        method: "POST",
        url: "/v1/billing/portal",
        headers: { cookie: owner.cookie, "x-tenant-id": owner.tenantId },
      });

      // 503, not 404: "not configured" and "does not exist" are different
      // things to whoever is reading the logs.
      expect(response.statusCode).toBe(503);

      const listed = await app.inject({
        method: "GET",
        url: "/v1/billing/subscription",
        headers: { cookie: owner.cookie, "x-tenant-id": owner.tenantId },
      });

      // And the screen is told, so it renders no button at all.
      expect(listed.json<{ portalAvailable: boolean }>().portalAvailable).toBe(false);
    });

    it("refuses an organization that has never paid through Stripe", async () => {
      const owner = await pendingOwner("portalnone");

      const response = await app.inject({
        method: "POST",
        url: "/v1/billing/portal",
        headers: { cookie: owner.cookie, "x-tenant-id": owner.tenantId },
      });

      expect(response.statusCode).toBe(409);
    });

    /**
     * The happy path, through the service rather than the route.
     *
     * Everything else in this file goes through `inject`, but a portal session
     * is the one billing operation that needs a live Stripe call, and there is
     * no appetite for a network round trip in a suite. The injected creator
     * (§2.2) is what makes the assertion possible: the session is requested for
     * *this* tenant's customer id, and the URL comes back untouched.
     */
    it("creates a session for the tenant's own Stripe customer", async () => {
      const owner = await pendingOwner("portalok");
      const customerId = `cus_portalok-${RUN}`;

      await app.prisma.subscription.create({
        data: {
          tenantId: owner.tenantId,
          plan: "STARTER",
          status: "ACTIVE",
          stripeCustomerId: customerId,
        },
      });

      const asked: { customerId: string; returnUrl: string; locale: string }[] = [];

      const service = new BillingService(app.prisma, {
        planPrices: {},
        trialPeriodDays: 30,
        appBaseUrl: "http://localhost:3000",
        createPortalSession: async (input) => {
          asked.push(input);
          return { url: "https://billing.stripe.com/session/live_test" };
        },
      });

      const session = await service.portalSession(owner.tenantId);

      expect(session.url).toBe("https://billing.stripe.com/session/live_test");
      // `hu` is the default locale, whose URLs carry no prefix — so this is the
      // unchanged string, and the English case below is what proves the segment
      // is actually being computed rather than omitted.
      expect(asked).toEqual([
        {
          customerId,
          returnUrl: "http://localhost:3000/dashboard/subscription",
          locale: "hu",
        },
      ]);
    });

    /**
     * The other half of the same property.
     * docs/phase-9-owner-language-and-return-paths.md §4.2, §5.1.
     *
     * Both values here were previously fixed: the return URL was a constant
     * built once at composition time, and no locale was sent at all, so Stripe
     * fell back to the browser. An English organization got a Stripe portal in
     * whatever language the browser asked for and was returned to a Hungarian
     * page afterwards.
     */
    it("returns an English organization to its own screen, in its own language", async () => {
      const owner = await pendingOwner("portalen", "en");
      const customerId = `cus_portalen-${RUN}`;

      await app.prisma.subscription.create({
        data: {
          tenantId: owner.tenantId,
          plan: "STARTER",
          status: "ACTIVE",
          stripeCustomerId: customerId,
        },
      });

      const asked: { customerId: string; returnUrl: string; locale: string }[] = [];

      const service = new BillingService(app.prisma, {
        planPrices: {},
        trialPeriodDays: 30,
        appBaseUrl: "http://localhost:3000",
        createPortalSession: async (input) => {
          asked.push(input);
          return { url: "https://billing.stripe.com/session/live_test" };
        },
      });

      await service.portalSession(owner.tenantId);

      expect(asked).toEqual([
        {
          customerId,
          returnUrl: "http://localhost:3000/en/dashboard/subscription",
          locale: "en",
        },
      ]);
    });

    /**
     * The gate, in the state that made this route matter.
     *
     * `customer.subscription.deleted` leaves a former customer SUSPENDED, which
     * accepts no writes — so a `requireWritableTenant` on the billing module
     * would make the one screen that can fix a billing problem unreachable to
     * exactly the people who have one (§2). Like the pending-owner test above,
     * this is the enforcement of an exemption expressed by omission.
     */
    it("stays reachable for a suspended organization", async () => {
      const owner = await pendingOwner("portalsusp");

      await app.prisma.tenant.update({
        where: { id: owner.tenantId },
        data: { status: "SUSPENDED" },
      });

      const response = await app.inject({
        method: "POST",
        url: "/v1/billing/portal",
        headers: { cookie: owner.cookie, "x-tenant-id": owner.tenantId },
      });

      // 409 — no Stripe customer — is the route answering. A 403 would mean the
      // write gate refused before it ever got there, which is the bug.
      expect(response.statusCode, response.body).toBe(409);
    });
  });

  describe("the webhook", () => {
    it("is not registered when Stripe is unconfigured", async () => {
      // Rule 4, literally: with no key there is nothing that could verify a
      // signature, and an endpoint accepting unverified webhooks would be worse
      // than none. This app was built without STRIPE_SECRET_KEY.
      const response = await app.inject({
        method: "POST",
        url: "/v1/webhooks/stripe",
        payload: { id: "evt_test", type: "checkout.session.completed" },
      });

      expect(response.statusCode).toBe(404);
    });
  });

  describe("/v1/me", () => {
    it("reports the deadline so the dashboard can count down", async () => {
      const owner = await pendingOwner("me");

      const response = await app.inject({
        method: "GET",
        url: "/v1/me",
        headers: { cookie: owner.cookie, "x-tenant-id": owner.tenantId },
      });

      const body = response.json<{
        tenant: { status: string; subscribeBy: string | null; daysRemaining: number | null };
      }>();

      expect(body.tenant.status).toBe("PENDING_SUBSCRIPTION");
      expect(body.tenant.subscribeBy).not.toBeNull();
      // 14-day window, so 13 full days remain once a few milliseconds have run.
      expect(body.tenant.daysRemaining).toBe(13);
    });
  });
});
