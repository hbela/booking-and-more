import { z } from "zod";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { Permissions } from "@bam/auth";
import { commonErrorResponses, idSchema, paginatedSchema } from "@bam/contracts";
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
export const providerRoutes: FastifyPluginAsyncZod = async (app) => {
  const service = new ProviderService(app.prisma);
  const providers = service.repository;

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
