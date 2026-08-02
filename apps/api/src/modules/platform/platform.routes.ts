import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { commonErrorResponses } from "@bam/contracts";

import { PlatformService } from "./platform.service.js";
import {
  listOrganizationsQuerySchema,
  organizationIdParamsSchema,
  organizationListResponseSchema,
  organizationSummarySchema,
  provisionOrganizationBodySchema,
  provisionOrganizationResponseSchema,
  setStatusBodySchema,
} from "./platform.schemas.js";

/**
 * Platform administration. docs/phase-9-saas-administration.md §4.
 *
 * Registered outside the tenant-scoped tree: these calls carry no `X-Tenant-Id`
 * because they are *about* tenants rather than *within* one. `platform` is
 * already in the reserved-slug list, so no tenant can shadow the prefix.
 *
 * Every route is guarded by `requirePlatformAdmin`, which checks the user flag
 * rather than a permission — `can()` returns true for a platform admin in every
 * tenant, so a permission check here would be satisfied by nothing at all.
 */

export interface PlatformRoutesOptions {
  appBaseUrl: string;
  onboardingWindowDays: number;
  invitationExpiryHours: number;
}

export const platformRoutes: FastifyPluginAsyncZod<PlatformRoutesOptions> = async (
  app,
  options,
) => {
  const service = new PlatformService(app.prisma, {
    onboardingWindowDays: options.onboardingWindowDays,
    invitationExpiryHours: options.invitationExpiryHours,
  });

  // --- List -----------------------------------------------------------------
  app.get(
    "/organizations",
    {
      preHandler: [app.requirePlatformAdmin],
      schema: {
        tags: ["platform"],
        summary: "List every organization",
        description:
          "The platform dashboard's main view. Returns account-level state only — never a tenant's bookings, customers or providers.",
        querystring: listOrganizationsQuerySchema,
        response: { 200: organizationListResponseSchema, ...commonErrorResponses },
      },
    },
    async (request) => {
      const items = await service.list(request.query);
      return { items };
    },
  );

  // --- Provision ------------------------------------------------------------
  app.post(
    "/organizations",
    {
      preHandler: [app.requirePlatformAdmin],
      schema: {
        tags: ["platform"],
        summary: "Provision an organization for an owner",
        description:
          "Creates the organization and invites its owner, in one transaction. The caller does NOT become a member — a platform admin holds no memberships (CLAUDE.md rule 9). PROSPECT organizations are gated until they subscribe and expire if they do not; INTERNAL organizations are active immediately and never expire.",
        body: provisionOrganizationBodySchema,
        response: { 201: provisionOrganizationResponseSchema, ...commonErrorResponses },
      },
    },
    async (request, reply) => {
      const user = request.user!;
      const result = await service.provision(request.body, user.id);

      request.audit({
        action: "platform.organization_provisioned",
        entityType: "Tenant",
        entityId: result.tenantId,
        tenantId: result.tenantId,
        after: {
          slug: request.body.slug,
          domain: request.body.domain,
          mode: request.body.mode,
          ownerEmail: request.body.ownerEmail,
        },
      });

      const organization = (await service.list({})).find((entry) => entry.id === result.tenantId)!;

      return reply.status(201).send({
        organization,
        acceptUrl: `${options.appBaseUrl}/invitations/${result.invitationToken}`,
      });
    },
  );

  // --- Resend the owner's invitation ---------------------------------------
  app.post(
    "/organizations/:id/resend-invitation",
    {
      preHandler: [app.requirePlatformAdmin],
      schema: {
        tags: ["platform"],
        summary: "Reissue the owner's acceptance link",
        description:
          "The invitation expires in 168 hours while the organization has longer to subscribe, so a lapsed link needs reissuing. The previous link stops working immediately.",
        params: organizationIdParamsSchema,
        response: {
          200: provisionOrganizationResponseSchema.pick({ acceptUrl: true }),
          ...commonErrorResponses,
        },
      },
    },
    async (request) => {
      const user = request.user!;
      const result = await service.resendInvitation(request.params.id, user.id);

      request.audit({
        action: "platform.owner_invitation_resent",
        entityType: "Tenant",
        entityId: request.params.id,
        tenantId: request.params.id,
        after: { ownerEmail: result.acceptEmail },
      });

      return { acceptUrl: `${options.appBaseUrl}/invitations/${result.invitationToken}` };
    },
  );

  // --- Suspend / reactivate -------------------------------------------------
  app.patch(
    "/organizations/:id/status",
    {
      preHandler: [app.requirePlatformAdmin],
      schema: {
        tags: ["platform"],
        summary: "Suspend or reactivate an organization",
        description:
          "A suspended tenant accepts no writes and takes no new bookings. Closing is a separate, heavier action and is deliberately not settable here.",
        params: organizationIdParamsSchema,
        body: setStatusBodySchema,
        response: { 200: organizationSummarySchema, ...commonErrorResponses },
      },
    },
    async (request) => {
      const organization = await service.setStatus(request.params.id, request.body.status);

      request.audit({
        action:
          request.body.status === "SUSPENDED"
            ? "platform.organization_suspended"
            : "platform.organization_reactivated",
        entityType: "Tenant",
        entityId: request.params.id,
        tenantId: request.params.id,
        // The status reached, not the one asked for: reactivation resolves to
        // TRIAL or PENDING_SUBSCRIPTION depending on the subscription, and an
        // audit trail that records the request rather than the outcome is a
        // trail of what somebody clicked, not of what happened.
        after: { status: organization.status },
      });

      return organization;
    },
  );
};
