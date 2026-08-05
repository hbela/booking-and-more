import { z } from "zod";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { Permissions } from "@bam/auth";
import { buildAppUrl, commonErrorResponses, idSchema, paginatedSchema } from "@bam/contracts";
// The Prisma join-table types are aliased: `ProviderService` is also the name of
// this module's service class, and the domain gives us no better word for
// either.
import type {
  Location,
  Provider,
  ProviderLocation as ProviderLocationRow,
  ProviderService as ProviderServiceRow,
  Service,
} from "@bam/db";
import { pageOf } from "../../lib/pagination.js";
import { MembershipService } from "../memberships/membership.service.js";
import { ProviderService } from "./provider.service.js";
import {
  createProviderBodySchema,
  listProvidersQuerySchema,
  providerLocationResponseSchema,
  providerResponseSchema,
  providerServiceResponseSchema,
  setProviderLocationsBodySchema,
  setProviderServicesBodySchema,
  updateProviderBodySchema,
} from "./provider.schemas.js";

export function toProviderResponse(provider: Provider): z.infer<typeof providerResponseSchema> {
  return {
    id: provider.id,
    displayName: provider.displayName,
    description: provider.description,
    email: provider.email,
    phone: provider.phone,
    timezone: provider.timezone,
    languages: provider.languages,
    active: provider.active,
    onlineBookingEnabled: provider.onlineBookingEnabled,
    minimumNoticeMinutes: provider.minimumNoticeMinutes,
    maximumAdvanceDays: provider.maximumAdvanceDays,
    archivedAt: provider.archivedAt?.toISOString() ?? null,
    createdAt: provider.createdAt.toISOString(),
    updatedAt: provider.updatedAt.toISOString(),
  };
}

/**
 * An assignment is "live" only if the thing it points at is itself bookable.
 * Both flags are reported so the dashboard can show an assignment that exists
 * but is currently doing nothing.
 */
function toAssignedService(
  row: ProviderServiceRow & { service: Service },
): z.infer<typeof providerServiceResponseSchema> {
  return {
    serviceId: row.serviceId,
    serviceName: row.service.name,
    serviceSlug: row.service.slug,
    serviceActive: row.service.active && row.service.archivedAt === null,
    durationMinutes: row.customDurationMinutes ?? row.service.durationMinutes,
    customDurationMinutes: row.customDurationMinutes,
    customPriceMinor: row.customPriceMinor,
    active: row.active,
  };
}

function toAssignedLocation(
  row: ProviderLocationRow & { location: Location },
): z.infer<typeof providerLocationResponseSchema> {
  return {
    locationId: row.locationId,
    locationName: row.location.name,
    locationType: row.location.type,
    locationActive: row.location.active && row.location.archivedAt === null,
    active: row.active,
  };
}

/**
 * Staff provider management. tech-impl §17.
 *
 * Every route asks for a permission rather than a role (CLAUDE.md rule 10), and
 * every write additionally requires a writable tenant, so a suspended account
 * can still be read but not reconfigured.
 */
export interface ProviderRoutesOptions {
  invitationExpiryHours: number;
  appBaseUrl: string;
}

export const providerRoutes: FastifyPluginAsyncZod<ProviderRoutesOptions> = async (app, options) => {
  const service = new ProviderService(app.prisma);
  const providers = service.repository;
  // Invitations are the membership module's business, including this one — see
  // the doc comment on `inviteProvider`. This route's own job is the rule-5
  // lookup that proves the diary belongs to the caller's tenant.
  const memberships = new MembershipService(app.prisma);

  // --- List -----------------------------------------------------------------
  app.get(
    "",
    {
      // Reading the catalogue is not a management action: an assistant needs to
      // see who works here to take a booking over the phone.
      preHandler: [app.requirePermission(Permissions.TENANT_READ)],
      schema: {
        tags: ["providers"],
        summary: "List providers",
        description:
          "Ordered by display name. Archived providers are excluded unless includeArchived is set.",
        querystring: listProvidersQuerySchema,
        response: { 200: paginatedSchema(providerResponseSchema), ...commonErrorResponses },
      },
    },
    async (request) => {
      const { limit, cursor, includeArchived, active } = request.query;

      const rows = await providers.list({
        tenantId: request.tenant!.id,
        limit,
        cursor,
        includeArchived,
        active,
      });

      return pageOf(rows, limit, (row) => row.displayName, toProviderResponse);
    },
  );

  // --- Create ---------------------------------------------------------------
  app.post(
    "",
    {
      preHandler: [app.requireWritableTenant, app.requirePermission(Permissions.PROVIDER_MANAGE)],
      schema: {
        tags: ["providers"],
        summary: "Create a provider",
        description:
          "A provider is a bookable resource, not an account. Give them a login by linking a membership to this provider (PATCH /v1/members/:membershipId).",
        body: createProviderBodySchema,
        response: { 201: providerResponseSchema, ...commonErrorResponses },
      },
    },
    async (request, reply) => {
      const tenant = request.tenant!;

      const provider = await service.create({
        tenantId: tenant.id,
        input: request.body,
        defaults: { timezone: tenant.defaultTimezone, language: tenant.defaultLanguage },
      });

      request.audit({
        action: "provider.created",
        entityType: "Provider",
        entityId: provider.id,
        after: toProviderResponse(provider),
      });

      return reply.status(201).send(toProviderResponse(provider));
    },
  );

  // --- Read -----------------------------------------------------------------
  app.get(
    "/:providerId",
    {
      preHandler: [app.requirePermission(Permissions.TENANT_READ)],
      schema: {
        tags: ["providers"],
        summary: "Read a provider",
        params: z.object({ providerId: idSchema }),
        response: { 200: providerResponseSchema, ...commonErrorResponses },
      },
    },
    async (request) => {
      const provider = await providers.findByIdOrThrow({
        tenantId: request.tenant!.id,
        providerId: request.params.providerId,
        // Archived providers stay readable by id so a booking detail screen can
        // still name who the appointment was with.
        includeArchived: true,
      });

      return toProviderResponse(provider);
    },
  );

  // --- Update ---------------------------------------------------------------
  app.patch(
    "/:providerId",
    {
      preHandler: [app.requireWritableTenant, app.requirePermission(Permissions.PROVIDER_MANAGE)],
      schema: {
        tags: ["providers"],
        summary: "Update a provider",
        params: z.object({ providerId: idSchema }),
        body: updateProviderBodySchema,
        response: { 200: providerResponseSchema, ...commonErrorResponses },
      },
    },
    async (request) => {
      const tenantId = request.tenant!.id;
      const { providerId } = request.params;

      const before = await providers.findByIdOrThrow({ tenantId, providerId });
      const updated = await service.update({ tenantId, providerId, input: request.body });

      request.audit({
        action: "provider.updated",
        entityType: "Provider",
        entityId: providerId,
        before: toProviderResponse(before),
        after: toProviderResponse(updated),
      });

      return toProviderResponse(updated);
    },
  );

  // --- Archive --------------------------------------------------------------
  app.delete(
    "/:providerId",
    {
      preHandler: [app.requireWritableTenant, app.requirePermission(Permissions.PROVIDER_MANAGE)],
      schema: {
        tags: ["providers"],
        summary: "Archive a provider",
        description:
          "Archives rather than deletes. Bookings keep pointing at the provider they were made with, and the row disappears from every list and picker.",
        params: z.object({ providerId: idSchema }),
        response: { 204: z.null(), ...commonErrorResponses },
      },
    },
    async (request, reply) => {
      const tenantId = request.tenant!.id;
      const { providerId } = request.params;

      const before = await providers.findByIdOrThrow({ tenantId, providerId });
      await service.archive({ tenantId, providerId });

      request.audit({
        action: "provider.archived",
        entityType: "Provider",
        entityId: providerId,
        before: toProviderResponse(before),
      });

      return reply.status(204).send(null);
    },
  );

  // --- Restore --------------------------------------------------------------
  //
  // A route of its own rather than `archivedAt: null` on the PATCH body, for the
  // same reason archiving is a DELETE (see provider.schemas.ts): it stays one
  // auditable action instead of a field any edit form could toggle by accident
  // while round-tripping what it read.
  app.post(
    "/:providerId/restore",
    {
      preHandler: [app.requireWritableTenant, app.requirePermission(Permissions.PROVIDER_MANAGE)],
      schema: {
        tags: ["providers"],
        summary: "Restore an archived provider",
        description:
          "Clears archivedAt and leaves the provider inactive, so restoring never puts them back in front of customers in one step. Restoring a provider that is not archived is a no-op.",
        params: z.object({ providerId: idSchema }),
        // 200 rather than 204: the caller needs to see that `active` came back
        // false, so it can offer the second, deliberate press.
        response: { 200: providerResponseSchema, ...commonErrorResponses },
      },
    },
    async (request) => {
      const tenantId = request.tenant!.id;
      const { providerId } = request.params;

      const before = await providers.findByIdOrThrow({
        tenantId,
        providerId,
        includeArchived: true,
      });
      const restored = await service.restore({ tenantId, providerId });

      // Nothing changed, so nothing is recorded — an audit trail of no-ops is
      // noise that makes the real restore harder to find.
      if (before.archivedAt !== null) {
        request.audit({
          action: "provider.restored",
          entityType: "Provider",
          entityId: providerId,
          before: toProviderResponse(before),
          after: toProviderResponse(restored),
        });
      }

      return toProviderResponse(restored);
    },
  );

  // --- Invite the person behind the diary ------------------------------------
  //
  // docs/phase-9-provider-onboarding.md. This is the whole of "give a provider
  // a login": until it existed, doing so meant issuing a generic invitation on
  // one screen and then linking the resulting membership to the diary on
  // another — and the second screen was never built, so every PROVIDER
  // membership held `:own` permissions that matched nothing.
  app.post(
    "/:providerId/invitation",
    {
      // MEMBER_MANAGE, not PROVIDER_MANAGE. The row this creates is an
      // Invitation that grants a Membership; the provider is the *object*, not
      // the thing being changed (rule 10). OWNER and ADMIN hold both today, so
      // nothing behaves differently — the point is that a future "may configure
      // the catalogue but not hand out logins" role needs no edit here.
      preHandler: [app.requireWritableTenant, app.requirePermission(Permissions.MEMBER_MANAGE)],
      // Same budget as POST /v1/members/invitations: the same act.
      config: { rateLimit: { max: 30, timeWindow: "1 hour" } },
      schema: {
        tags: ["providers"],
        summary: "Invite this provider to set up their own login",
        description:
          "Emails the address on the provider record a single-use link. Accepting it creates the account, grants PROVIDER, and links the membership to this diary in one transaction — there is no second step. Re-inviting supersedes any live invitation for this provider or this address, so the newest link is the only one that works. There is no body: the role is always PROVIDER and the address comes from the provider record, because a route that accepted one alongside a provider id would be a way to attach any mailbox to a named diary. Correct a wrong address with PATCH /v1/providers/:providerId first.",
        params: z.object({ providerId: idSchema }),
        response: {
          201: z.object({
            id: idSchema,
            email: z.email(),
            role: z.literal("PROVIDER"),
            providerId: idSchema,
            expiresAt: z.iso.datetime({ offset: true }),
            /**
             * Shown once, and still returned even though an email is now sent:
             * the worker memoises its email provider at boot and one that
             * cannot deliver writes SKIPPED rather than a fake SENT
             * (phase-9-owner-onboarding-emails §2). Without this an owner in
             * that state has no recovery path at all. The UI keeps it behind a
             * disclosure so the email stays the affordance.
             */
            acceptUrl: z.url(),
          }),
          ...commonErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const tenant = request.tenant!;
      const { providerId } = request.params;

      // Deliberately without includeArchived: an archived provider is a 404
      // here by construction, which is the same answer as "no such provider"
      // and needs no second branch (rule 5).
      const provider = await providers.findByIdOrThrow({ tenantId: tenant.id, providerId });

      const result = await memberships.inviteProvider({
        tenantId: tenant.id,
        provider,
        invitedByUserId: request.user!.id,
        invitedByName: request.user!.name,
        expiryHours: options.invitationExpiryHours,
      });

      // The same action a generic invitation records, so "who was invited into
      // this tenant" stays one grep. The token is never audited or logged.
      request.audit({
        action: "membership.invited",
        entityType: "Invitation",
        entityId: result.invitationId,
        after: { email: result.email, role: "PROVIDER", providerId },
      });

      return reply.status(201).send({
        id: result.invitationId,
        email: result.email,
        role: "PROVIDER" as const,
        providerId,
        expiresAt: result.expiresAt.toISOString(),
        acceptUrl: buildAppUrl({
          baseUrl: options.appBaseUrl,
          path: `/invitations/${result.token}`,
          locale: tenant.defaultLanguage,
        }),
      });
    },
  );

  // --- Service assignments --------------------------------------------------
  app.get(
    "/:providerId/services",
    {
      preHandler: [app.requirePermission(Permissions.TENANT_READ)],
      schema: {
        tags: ["providers"],
        summary: "List the services a provider offers",
        params: z.object({ providerId: idSchema }),
        response: {
          200: z.object({ items: z.array(providerServiceResponseSchema) }),
          ...commonErrorResponses,
        },
      },
    },
    async (request) => {
      const tenantId = request.tenant!.id;
      const { providerId } = request.params;

      await providers.findByIdOrThrow({ tenantId, providerId, includeArchived: true });
      const rows = await providers.listServices({ tenantId, providerId });

      return { items: rows.map(toAssignedService) };
    },
  );

  app.put(
    "/:providerId/services",
    {
      preHandler: [app.requireWritableTenant, app.requirePermission(Permissions.PROVIDER_MANAGE)],
      schema: {
        tags: ["providers"],
        summary: "Replace the services a provider offers",
        description:
          "Send the complete set. Anything omitted is unassigned. Idempotent, so a repeated submit converges rather than duplicating.",
        params: z.object({ providerId: idSchema }),
        body: setProviderServicesBodySchema,
        response: {
          200: z.object({ items: z.array(providerServiceResponseSchema) }),
          ...commonErrorResponses,
        },
      },
    },
    async (request) => {
      const tenantId = request.tenant!.id;
      const { providerId } = request.params;

      await service.setServices({ tenantId, providerId, services: request.body.services });
      const rows = await providers.listServices({ tenantId, providerId });

      request.audit({
        action: "provider.services_changed",
        entityType: "Provider",
        entityId: providerId,
        after: { serviceIds: rows.map((row) => row.serviceId) },
      });

      return { items: rows.map(toAssignedService) };
    },
  );

  // --- Location assignments -------------------------------------------------
  app.get(
    "/:providerId/locations",
    {
      preHandler: [app.requirePermission(Permissions.TENANT_READ)],
      schema: {
        tags: ["providers"],
        summary: "List where a provider works",
        params: z.object({ providerId: idSchema }),
        response: {
          200: z.object({ items: z.array(providerLocationResponseSchema) }),
          ...commonErrorResponses,
        },
      },
    },
    async (request) => {
      const tenantId = request.tenant!.id;
      const { providerId } = request.params;

      await providers.findByIdOrThrow({ tenantId, providerId, includeArchived: true });
      const rows = await providers.listLocations({ tenantId, providerId });

      return { items: rows.map(toAssignedLocation) };
    },
  );

  app.put(
    "/:providerId/locations",
    {
      preHandler: [app.requireWritableTenant, app.requirePermission(Permissions.PROVIDER_MANAGE)],
      schema: {
        tags: ["providers"],
        summary: "Replace where a provider works",
        description: "Send the complete set. Anything omitted is unassigned.",
        params: z.object({ providerId: idSchema }),
        body: setProviderLocationsBodySchema,
        response: {
          200: z.object({ items: z.array(providerLocationResponseSchema) }),
          ...commonErrorResponses,
        },
      },
    },
    async (request) => {
      const tenantId = request.tenant!.id;
      const { providerId } = request.params;

      await service.setLocations({ tenantId, providerId, locations: request.body.locations });
      const rows = await providers.listLocations({ tenantId, providerId });

      request.audit({
        action: "provider.locations_changed",
        entityType: "Provider",
        entityId: providerId,
        after: { locationIds: rows.map((row) => row.locationId) },
      });

      return { items: rows.map(toAssignedLocation) };
    },
  );
};
