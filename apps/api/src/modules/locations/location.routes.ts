import { z } from "zod";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { Permissions } from "@bam/auth";
import { commonErrorResponses, idSchema, paginatedSchema } from "@bam/contracts";
import type { Location } from "@bam/db";
import { pageOf } from "../../lib/pagination.js";
import { LocationService } from "./location.service.js";
import {
  createLocationBodySchema,
  listLocationsQuerySchema,
  locationResponseSchema,
  updateLocationBodySchema,
} from "./location.schemas.js";

export function toLocationResponse(location: Location): z.infer<typeof locationResponseSchema> {
  return {
    id: location.id,
    name: location.name,
    type: location.type,
    addressLine1: location.addressLine1,
    addressLine2: location.addressLine2,
    city: location.city,
    postalCode: location.postalCode,
    countryCode: location.countryCode,
    timezone: location.timezone,
    latitude: location.latitude,
    longitude: location.longitude,
    active: location.active,
    archivedAt: location.archivedAt?.toISOString() ?? null,
    createdAt: location.createdAt.toISOString(),
    updatedAt: location.updatedAt.toISOString(),
  };
}

/** Staff location management. tech-impl §17. */
export const locationRoutes: FastifyPluginAsyncZod = async (app) => {
  const service = new LocationService(app.prisma);
  const locations = service.repository;

  // --- List -----------------------------------------------------------------
  app.get(
    "",
    {
      preHandler: [app.requirePermission(Permissions.TENANT_READ)],
      schema: {
        tags: ["locations"],
        summary: "List locations",
        querystring: listLocationsQuerySchema,
        response: { 200: paginatedSchema(locationResponseSchema), ...commonErrorResponses },
      },
    },
    async (request) => {
      const { limit, cursor, includeArchived, active } = request.query;

      const rows = await locations.list({
        tenantId: request.tenant!.id,
        limit,
        cursor,
        includeArchived,
        active,
      });

      return pageOf(rows, limit, (row) => row.name, toLocationResponse);
    },
  );

  // --- Create ---------------------------------------------------------------
  app.post(
    "",
    {
      preHandler: [app.requireWritableTenant, app.requirePermission(Permissions.LOCATION_MANAGE)],
      schema: {
        tags: ["locations"],
        summary: "Create a location",
        description:
          "ONLINE, HOME_VISIT and TELEPHONE locations need no address. A PHYSICAL one does.",
        body: createLocationBodySchema,
        response: { 201: locationResponseSchema, ...commonErrorResponses },
      },
    },
    async (request, reply) => {
      const tenant = request.tenant!;

      const location = await service.create({
        tenantId: tenant.id,
        input: request.body,
        defaultTimezone: tenant.defaultTimezone,
      });

      request.audit({
        action: "location.created",
        entityType: "Location",
        entityId: location.id,
        after: toLocationResponse(location),
      });

      return reply.status(201).send(toLocationResponse(location));
    },
  );

  // --- Read -----------------------------------------------------------------
  app.get(
    "/:locationId",
    {
      preHandler: [app.requirePermission(Permissions.TENANT_READ)],
      schema: {
        tags: ["locations"],
        summary: "Read a location",
        params: z.object({ locationId: idSchema }),
        response: { 200: locationResponseSchema, ...commonErrorResponses },
      },
    },
    async (request) => {
      const location = await locations.findByIdOrThrow({
        tenantId: request.tenant!.id,
        locationId: request.params.locationId,
        includeArchived: true,
      });

      return toLocationResponse(location);
    },
  );

  // --- Update ---------------------------------------------------------------
  app.patch(
    "/:locationId",
    {
      preHandler: [app.requireWritableTenant, app.requirePermission(Permissions.LOCATION_MANAGE)],
      schema: {
        tags: ["locations"],
        summary: "Update a location",
        params: z.object({ locationId: idSchema }),
        body: updateLocationBodySchema,
        response: { 200: locationResponseSchema, ...commonErrorResponses },
      },
    },
    async (request) => {
      const tenantId = request.tenant!.id;
      const { locationId } = request.params;

      const before = await locations.findByIdOrThrow({ tenantId, locationId });
      const updated = await service.update({ tenantId, locationId, input: request.body });

      request.audit({
        action: "location.updated",
        entityType: "Location",
        entityId: locationId,
        before: toLocationResponse(before),
        after: toLocationResponse(updated),
      });

      return toLocationResponse(updated);
    },
  );

  // --- Archive --------------------------------------------------------------
  app.delete(
    "/:locationId",
    {
      preHandler: [app.requireWritableTenant, app.requirePermission(Permissions.LOCATION_MANAGE)],
      schema: {
        tags: ["locations"],
        summary: "Archive a location",
        params: z.object({ locationId: idSchema }),
        response: { 204: z.null(), ...commonErrorResponses },
      },
    },
    async (request, reply) => {
      const tenantId = request.tenant!.id;
      const { locationId } = request.params;

      const before = await locations.findByIdOrThrow({ tenantId, locationId });
      await service.archive({ tenantId, locationId });

      request.audit({
        action: "location.archived",
        entityType: "Location",
        entityId: locationId,
        before: toLocationResponse(before),
      });

      return reply.status(204).send(null);
    },
  );

  // --- Restore --------------------------------------------------------------
  //
  // Its own route rather than a PATCH field, matching the DELETE it undoes and
  // the two sibling catalogues. Restoring leaves the location inactive: DELETE
  // sets both flags, but "gone" and "off for now" are different questions
  // (rule 11), and only the first is being answered here.
  app.post(
    "/:locationId/restore",
    {
      preHandler: [app.requireWritableTenant, app.requirePermission(Permissions.LOCATION_MANAGE)],
      schema: {
        tags: ["locations"],
        summary: "Restore an archived location",
        description:
          "Clears archivedAt and leaves the location inactive. Restoring a location that is not archived is a no-op.",
        params: z.object({ locationId: idSchema }),
        response: { 200: locationResponseSchema, ...commonErrorResponses },
      },
    },
    async (request) => {
      const tenantId = request.tenant!.id;
      const { locationId } = request.params;

      const before = await locations.findByIdOrThrow({
        tenantId,
        locationId,
        includeArchived: true,
      });
      const restored = await service.restore({ tenantId, locationId });

      // A no-op restore is not an audit event.
      if (before.archivedAt !== null) {
        request.audit({
          action: "location.restored",
          entityType: "Location",
          entityId: locationId,
          before: toLocationResponse(before),
          after: toLocationResponse(restored),
        });
      }

      return toLocationResponse(restored);
    },
  );
};
