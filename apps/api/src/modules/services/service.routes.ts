import { z } from "zod";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { Permissions } from "@bam/auth";
import { commonErrorResponses, idSchema, paginatedSchema } from "@bam/contracts";
import { pageOf } from "../../lib/pagination.js";
import { ServiceCatalogService } from "./service.service.js";
import type { ServiceWithTranslations } from "./service.repository.js";
import {
  createServiceBodySchema,
  listServicesQuerySchema,
  serviceResponseSchema,
  setServiceTranslationsBodySchema,
  updateServiceBodySchema,
} from "./service.schemas.js";

export function toServiceResponse(
  service: ServiceWithTranslations,
): z.infer<typeof serviceResponseSchema> {
  return {
    id: service.id,
    name: service.name,
    slug: service.slug,
    description: service.description,
    durationMinutes: service.durationMinutes,
    bufferBeforeMinutes: service.bufferBeforeMinutes,
    bufferAfterMinutes: service.bufferAfterMinutes,
    priceMinor: service.priceMinor,
    currency: service.currency,
    active: service.active,
    requiresApproval: service.requiresApproval,
    minimumNoticeMinutes: service.minimumNoticeMinutes,
    maximumAdvanceDays: service.maximumAdvanceDays,
    translations: service.translations.map((translation) => ({
      locale: translation.locale,
      name: translation.name,
      description: translation.description,
    })),
    archivedAt: service.archivedAt?.toISOString() ?? null,
    createdAt: service.createdAt.toISOString(),
    updatedAt: service.updatedAt.toISOString(),
  };
}

/** Staff service management. tech-impl §17. */
export const serviceRoutes: FastifyPluginAsyncZod = async (app) => {
  const catalog = new ServiceCatalogService(app.prisma);
  const services = catalog.repository;

  // --- List -----------------------------------------------------------------
  app.get(
    "",
    {
      preHandler: [app.requirePermission(Permissions.TENANT_READ)],
      schema: {
        tags: ["services"],
        summary: "List services",
        description:
          "Ordered by name. Pass providerId to see only what one provider offers — that is the same filter the booking flow uses.",
        querystring: listServicesQuerySchema,
        response: { 200: paginatedSchema(serviceResponseSchema), ...commonErrorResponses },
      },
    },
    async (request) => {
      const { limit, cursor, includeArchived, active, providerId } = request.query;

      const rows = await services.list({
        tenantId: request.tenant!.id,
        limit,
        cursor,
        includeArchived,
        active,
        providerId,
      });

      return pageOf(rows, limit, (row) => row.name, toServiceResponse);
    },
  );

  // --- Create ---------------------------------------------------------------
  app.post(
    "",
    {
      preHandler: [app.requireWritableTenant, app.requirePermission(Permissions.SERVICE_MANAGE)],
      schema: {
        tags: ["services"],
        summary: "Create a service",
        description:
          "The slug is derived from the name when omitted. Prices are integer minor units and always carry a currency (tech-impl §10.5).",
        body: createServiceBodySchema,
        response: { 201: serviceResponseSchema, ...commonErrorResponses },
      },
    },
    async (request, reply) => {
      const service = await catalog.create({
        tenantId: request.tenant!.id,
        input: request.body,
      });

      request.audit({
        action: "service.created",
        entityType: "Service",
        entityId: service.id,
        after: toServiceResponse(service),
      });

      return reply.status(201).send(toServiceResponse(service));
    },
  );

  // --- Read -----------------------------------------------------------------
  app.get(
    "/:serviceId",
    {
      preHandler: [app.requirePermission(Permissions.TENANT_READ)],
      schema: {
        tags: ["services"],
        summary: "Read a service",
        params: z.object({ serviceId: idSchema }),
        response: {
          200: serviceResponseSchema.extend({
            providers: z.array(
              z.object({
                providerId: idSchema,
                displayName: z.string(),
                active: z.boolean(),
              }),
            ),
          }),
          ...commonErrorResponses,
        },
      },
    },
    async (request) => {
      const tenantId = request.tenant!.id;
      const { serviceId } = request.params;

      const service = await services.findByIdOrThrow({
        tenantId,
        serviceId,
        includeArchived: true,
      });
      const assignments = await services.listProviders({ tenantId, serviceId });

      return {
        ...toServiceResponse(service),
        providers: assignments.map((row) => ({
          providerId: row.providerId,
          displayName: row.provider.displayName,
          // Live only when both the assignment and the provider are.
          active: row.active && row.provider.active && row.provider.archivedAt === null,
        })),
      };
    },
  );

  // --- Update ---------------------------------------------------------------
  app.patch(
    "/:serviceId",
    {
      preHandler: [app.requireWritableTenant, app.requirePermission(Permissions.SERVICE_MANAGE)],
      schema: {
        tags: ["services"],
        summary: "Update a service",
        params: z.object({ serviceId: idSchema }),
        body: updateServiceBodySchema,
        response: { 200: serviceResponseSchema, ...commonErrorResponses },
      },
    },
    async (request) => {
      const tenantId = request.tenant!.id;
      const { serviceId } = request.params;

      const before = await services.findByIdOrThrow({ tenantId, serviceId });
      const updated = await catalog.update({ tenantId, serviceId, input: request.body });

      request.audit({
        action: "service.updated",
        entityType: "Service",
        entityId: serviceId,
        before: toServiceResponse(before),
        after: toServiceResponse(updated),
      });

      return toServiceResponse(updated);
    },
  );

  // --- Archive --------------------------------------------------------------
  app.delete(
    "/:serviceId",
    {
      preHandler: [app.requireWritableTenant, app.requirePermission(Permissions.SERVICE_MANAGE)],
      schema: {
        tags: ["services"],
        summary: "Archive a service",
        description:
          "Archives rather than deletes, so bookings already taken keep naming what they were for.",
        params: z.object({ serviceId: idSchema }),
        response: { 204: z.null(), ...commonErrorResponses },
      },
    },
    async (request, reply) => {
      const tenantId = request.tenant!.id;
      const { serviceId } = request.params;

      const before = await services.findByIdOrThrow({ tenantId, serviceId });
      await catalog.archive({ tenantId, serviceId });

      request.audit({
        action: "service.archived",
        entityType: "Service",
        entityId: serviceId,
        before: toServiceResponse(before),
      });

      return reply.status(204).send(null);
    },
  );

  // --- Translations ---------------------------------------------------------
  app.put(
    "/:serviceId/translations",
    {
      preHandler: [app.requireWritableTenant, app.requirePermission(Permissions.SERVICE_MANAGE)],
      schema: {
        tags: ["services"],
        summary: "Replace a service's translations",
        description:
          "Send the complete set; omitted locales fall back to the service's own name and description (tech-impl §38).",
        params: z.object({ serviceId: idSchema }),
        body: setServiceTranslationsBodySchema,
        response: { 200: serviceResponseSchema, ...commonErrorResponses },
      },
    },
    async (request) => {
      const tenantId = request.tenant!.id;
      const { serviceId } = request.params;

      const updated = await catalog.setTranslations({
        tenantId,
        serviceId,
        translations: request.body.translations,
      });

      request.audit({
        action: "service.translations_changed",
        entityType: "Service",
        entityId: serviceId,
        after: { locales: updated.translations.map((translation) => translation.locale) },
      });

      return toServiceResponse(updated);
    },
  );
};
