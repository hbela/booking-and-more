import { z } from "zod";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { Permissions } from "@bam/auth";
import { commonErrorResponses, subscribablePlanSchema } from "@bam/contracts";

import { BillingService, type PaymentLinks } from "./billing.service.js";
import type { PortalSessionCreator } from "./stripe.client.js";

/**
 * Billing. docs/phase-9-subscription-and-activation.md §3.
 *
 * ## Why nothing here registers `requireWritableTenant`
 *
 * **This is the most important thing about this file** (phase-9 §2.4).
 * `tenantAcceptsWrites` refuses a `PENDING_SUBSCRIPTION` tenant, and subscribing
 * is itself a write. Gate these routes with everything else and the owner can
 * never subscribe, can never leave `PENDING_SUBSCRIPTION`, and their
 * organization expires while they are trying to pay for it — a bug that would
 * be found by the first paying customer.
 *
 * The exemption is expressed by omission, which is fragile: nothing stops a
 * later hand adding the guard "for consistency". What protects it is the test
 * in billing.test.ts asserting that a pending owner reaches this route and is
 * still refused `POST /v1/services`. If that test is ever deleted, this comment
 * is the only thing left.
 *
 * Permission, not role, per rule 10: `BILLING_MANAGE` is the owner's alone.
 */

export interface BillingRoutesOptions {
  paymentLinks: PaymentLinks;
  /** Omitted when Stripe is unconfigured; the portal then reports 503. */
  createPortalSession?: PortalSessionCreator | undefined;
  portalReturnUrl?: string | undefined;
  /** Copy only. Stripe owns the real trial length — see the config comment. */
  trialPeriodDays: number;
}

const subscriptionSchema = z
  .object({
    plan: z.enum(["INTERNAL", "STARTER", "PROFESSIONAL"]),
    status: z.enum(["ACTIVE", "PAST_DUE", "CANCELED", "INCOMPLETE", "TRIALING", "NOT_APPLICABLE"]),
    currentPeriodEnd: z.iso.datetime({ offset: true }).nullable(),
    cancelAtPeriodEnd: z.boolean(),
    /** When the free trial ends. Null once it has, or if there never was one. */
    trialEndsAt: z.iso.datetime({ offset: true }).nullable(),
    /**
     * A plan change that has not happened yet — a downgrade, which takes effect
     * at renewal (docs/phase-9-subscription-lifecycle.md §2.4). Both null when
     * nothing is scheduled; the screen shows the current plan alone.
     */
    pendingPlan: z.enum(["INTERNAL", "STARTER", "PROFESSIONAL"]).nullable(),
    pendingPlanStartsAt: z.iso.datetime({ offset: true }).nullable(),
  })
  .nullable();

export const billingRoutes: FastifyPluginAsyncZod<BillingRoutesOptions> = async (app, options) => {
  const service = new BillingService(app.prisma, {
    paymentLinks: options.paymentLinks,
    createPortalSession: options.createPortalSession,
    portalReturnUrl: options.portalReturnUrl,
  });

  // --- What the subscription screen renders --------------------------------
  app.get(
    "/subscription",
    {
      preHandler: [app.requirePermission(Permissions.BILLING_MANAGE)],
      schema: {
        tags: ["billing"],
        summary: "The organization's subscription, and the plans it may buy",
        description:
          "Available plans are those with a payment link configured. A plan that cannot be paid for is not offered, because a button leading to a blank Stripe page is worse than one that is absent.",
        response: {
          200: z.object({
            subscription: subscriptionSchema,
            availablePlans: z.array(subscribablePlanSchema),
            /** Whether "manage billing" can lead anywhere. See POST /portal. */
            portalAvailable: z.boolean(),
            /**
             * Whether subscribing now would start a free trial. False once the
             * organization has used one — the screen must not offer a trial it
             * will not get (§2.1).
             */
            trialAvailable: z.boolean(),
            /** For copy only, before there is a subscription to read. */
            trialPeriodDays: z.number().int().positive(),
          }),
          ...commonErrorResponses,
        },
      },
    },
    async (request) => {
      const tenant = request.tenant!;
      const subscription = await service.currentSubscription(tenant.id);

      return {
        subscription:
          subscription === null
            ? null
            : {
                ...subscription,
                currentPeriodEnd: subscription.currentPeriodEnd?.toISOString() ?? null,
                trialEndsAt: subscription.trialEndsAt?.toISOString() ?? null,
                pendingPlanStartsAt: subscription.pendingPlanStartsAt?.toISOString() ?? null,
              },
        availablePlans: service.availablePlans(),
        portalAvailable: service.portalAvailable(),
        trialAvailable: subscription?.trialUsedAt == null,
        trialPeriodDays: options.trialPeriodDays,
      };
    },
  );

  // --- Start a subscription -------------------------------------------------
  app.post(
    "/subscribe",
    {
      // No requireWritableTenant. See the note at the top of this file.
      preHandler: [app.requirePermission(Permissions.BILLING_MANAGE)],
      schema: {
        tags: ["billing"],
        summary: "Email the owner a payment link, and return it",
        description:
          "Returns the Stripe payment link and emails it to the caller. Both, deliberately: the owner sitting in front of the screen should not be blocked on mail delivery, and the emailed copy can be forwarded to whoever holds the company card. No card details ever reach this API — the link leads to Stripe's hosted page.",
        body: z.object({ plan: subscribablePlanSchema }),
        response: {
          201: z.object({
            paymentUrl: z.url(),
            emailedTo: z.email(),
            /**
             * Whether this link starts a free trial. False for an organization
             * that has already had one, which is the returning-customer path
             * (docs/phase-9-subscription-lifecycle.md §2.1) — the screen has to
             * say which, because "no charge today" is otherwise a lie.
             */
            trial: z.boolean(),
          }),
          ...commonErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const tenant = request.tenant!;
      const user = request.user!;

      const result = await service.requestPaymentLink({
        tenantId: tenant.id,
        plan: request.body.plan,
        recipientEmail: user.email,
        recipientName: user.name,
      });

      request.audit({
        action: "billing.payment_link_requested",
        entityType: "Tenant",
        entityId: tenant.id,
        tenantId: tenant.id,
        // The URL carries no secret — it is the same link for every customer on
        // this plan, plus the tenant id — but the plan is what an operator
        // would want to see in the trail. `trial` too: "did this organization
        // get thirty free days" is the first question asked of a billing
        // dispute, and it is decided here.
        after: { plan: request.body.plan, emailedTo: result.emailedTo, trial: result.trial },
      });

      return reply.status(201).send(result);
    },
  );

  // --- Manage an existing subscription --------------------------------------
  // POST, not GET, though the epic record's route list says GET
  // (docs/phase-9-customer-portal.md §1.2). Creating a portal session is a side
  // effect against Stripe, and the session expires within minutes — so a
  // browser prefetch, a link preview or a proxy warming the URL would burn one
  // before the owner had clicked anything. A GET must be safe to repeat.
  app.post(
    "/portal",
    {
      // No requireWritableTenant, and here for a second reason beyond §2.4's:
      // customer.subscription.deleted leaves a tenant SUSPENDED, which accepts
      // no writes — so gating this would make the one screen that can fix a
      // billing problem unreachable to exactly the people who have one.
      preHandler: [app.requirePermission(Permissions.BILLING_MANAGE)],
      schema: {
        tags: ["billing"],
        summary: "A link into Stripe's customer portal",
        description:
          "Creates a short-lived customer-portal session for the caller's organization and returns its URL, for changing the card, reading invoices or cancelling. The URL expires within minutes and authenticates its bearer into the billing account, so it is redirected to immediately and — unlike the payment link — never emailed. 409 when the organization has never paid through Stripe; 503 when billing is unconfigured.",
        response: {
          201: z.object({ url: z.url() }),
          ...commonErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const tenant = request.tenant!;
      const session = await service.portalSession(tenant.id);

      request.audit({
        action: "billing.portal_opened",
        entityType: "Tenant",
        entityId: tenant.id,
        tenantId: tenant.id,
        // Deliberately no URL in the trail. It is a bearer credential into the
        // organization's billing account, and an audit row is read by more
        // people, for longer, than the owner who asked for it (rule 6).
      });

      return reply.status(201).send(session);
    },
  );
};
