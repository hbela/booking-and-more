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
const STARTER_LINK = "https://buy.stripe.com/test_starter";
const STARTER_LINK_NO_TRIAL = "https://buy.stripe.com/test_starter_no_trial";

describe.skipIf(!databaseUrl)("billing", () => {
  let app: AppInstance;

  beforeAll(async () => {
    const env = loadEnv({
      source: {
        NODE_ENV: "test",
        LOG_LEVEL: "silent",
        APP_BASE_URL: "http://localhost:3000",
        API_BASE_URL: "http://localhost:3001",
        DATABASE_URL: databaseUrl!,
        BETTER_AUTH_SECRET: "test-secret-that-is-at-least-32-characters-long",
        STRIPE_PAYMENT_LINK_STARTER: STARTER_LINK,
        STRIPE_PAYMENT_LINK_STARTER_NO_TRIAL: STARTER_LINK_NO_TRIAL,
      },
      loadDotenvFile: false,
    });

    app = await buildApp({ env, logger: false, rateLimit: false });
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

      // The only thing tying a payment back to an organization: a Payment Link
      // is shared by every customer on the plan (§3.2).
      expect(url.searchParams.get("client_reference_id")).toBe(owner.tenantId);
      // The *trial* link, because this organization has never had one.
      expect(url.origin + url.pathname).toBe(STARTER_LINK);
      expect(body.emailedTo).toBe(owner.email);

      // Requested, not sent — a third-party call inside this request is how the
      // predecessor swallowed delivery failures.
      const events = await app.prisma.outboxEvent.findMany({
        where: { tenantId: owner.tenantId, eventType: "SUBSCRIPTION_LINK_REQUESTED" },
      });
      expect(events).toHaveLength(1);
    });

    it("refuses a plan with no payment link configured", async () => {
      // PROFESSIONAL has no link in this app's config, so it is not for sale.
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
    // docs/phase-9-subscription-lifecycle.md §2.1. A Payment Link's trial is a
    // property of the link, so "skip the trial for a returning customer" is a
    // second link rather than a parameter — which makes *which link was sent*
    // the only observable proof the gate works.
    it("sends the trial link to an organization that has never had one", async () => {
      const owner = await pendingOwner("trialnew");

      const response = await app.inject({
        method: "POST",
        url: "/v1/billing/subscribe",
        headers: { cookie: owner.cookie, "x-tenant-id": owner.tenantId },
        payload: { plan: "STARTER" },
      });

      expect(response.statusCode).toBe(201);

      const body = response.json<{ paymentUrl: string; trial: boolean }>();
      const url = new URL(body.paymentUrl);

      expect(url.origin + url.pathname).toBe(STARTER_LINK);
      expect(body.trial).toBe(true);
    });

    /**
     * The returning customer, and the reason `trialUsedAt` lives on a row that
     * survives cancellation.
     *
     * CANCELED is not a live status, so the duplicate-subscription guard lets
     * them through — which is right, they are allowed to come back. What they
     * are not allowed is another thirty free days.
     */
    it("sends the no-trial link to one that has already used its trial", async () => {
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
      const url = new URL(body.paymentUrl);

      expect(url.origin + url.pathname).toBe(STARTER_LINK_NO_TRIAL);
      expect(body.trial).toBe(false);
      // Still carries the tenant: the join key matters just as much second time.
      expect(url.searchParams.get("client_reference_id")).toBe(owner.tenantId);
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

      const asked: { customerId: string; returnUrl: string }[] = [];

      const service = new BillingService(app.prisma, {
        paymentLinks: {},
        portalReturnUrl: "http://localhost:3000/dashboard/subscription",
        createPortalSession: async (input) => {
          asked.push(input);
          return { url: "https://billing.stripe.com/session/live_test" };
        },
      });

      const session = await service.portalSession(owner.tenantId);

      expect(session.url).toBe("https://billing.stripe.com/session/live_test");
      expect(asked).toEqual([
        { customerId, returnUrl: "http://localhost:3000/dashboard/subscription" },
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
