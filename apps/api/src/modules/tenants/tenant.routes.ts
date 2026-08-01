import { z } from "zod";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { canHoldTenantMembership, Permissions } from "@bam/auth";
import { commonErrorResponses, ForbiddenError, idSchema } from "@bam/contracts";
import { TenantService } from "./tenant.service.js";
import {
  createTenantBodySchema,
  tenantResponseSchema,
  updateTenantBodySchema,
} from "./tenant.schemas.js";
import type { Tenant } from "@bam/db";

function toResponse(tenant: Tenant): z.infer<typeof tenantResponseSchema> {
  return {
    id: tenant.id,
    slug: tenant.slug,
    name: tenant.name,
    status: tenant.status,
    defaultTimezone: tenant.defaultTimezone,
    defaultLanguage: tenant.defaultLanguage,
    logoUrl: tenant.logoUrl,
    primaryColor: tenant.primaryColor,
    contactEmail: tenant.contactEmail,
    contactPhone: tenant.contactPhone,
    bookingPolicy: tenant.bookingPolicy,
    cancellationPolicy: tenant.cancellationPolicy,
    privacyPolicyUrl: tenant.privacyPolicyUrl,
    createdAt: tenant.createdAt.toISOString(),
    updatedAt: tenant.updatedAt.toISOString(),
  };
}

export const tenantRoutes: FastifyPluginAsyncZod = async (app) => {
  const service = new TenantService(app.prisma);

  // --- Create ---------------------------------------------------------------
  app.post(
    "",
    {
      // Only authentication: there is no tenant to have permission in yet. Any
      // signed-in user may create one, and becomes its OWNER.
      preHandler: [app.requireAuth],
      config: {
        // Tenant creation is cheap to abuse and expensive to clean up.
        rateLimit: { max: 5, timeWindow: "1 hour" },
      },
      schema: {
        tags: ["tenants"],
        summary: "Create a tenant",
        description:
          "Creates a tenant and makes the caller its OWNER, in one transaction. A tenant without an owner would be unreachable.",
        body: createTenantBodySchema,
        response: { 201: tenantResponseSchema, ...commonErrorResponses },
      },
    },
    async (request, reply) => {
      // requireAuth guarantees this.
      const user = request.user!;

      // Separation of duties: creating a tenant makes the caller its OWNER, and
      // an operator of the platform is not one of its customers. Refused here
      // rather than in the service because there is nothing to roll back yet.
      if (!canHoldTenantMembership(user)) {
        throw new ForbiddenError(
          "A platform administrator cannot own a tenant. Use a separate account for tenant work.",
        );
      }

      const tenant = await service.create(request.body, user.id);

      // tenantId is passed explicitly: the request had no tenant context when
      // it started, so the audit plugin cannot infer it.
      request.audit({
        action: "tenant.created",
        entityType: "Tenant",
        entityId: tenant.id,
        tenantId: tenant.id,
        after: { slug: tenant.slug, name: tenant.name, status: tenant.status },
      });

      await service.setActiveTenant(user.id, tenant.id);

      return reply.status(201).send(toResponse(tenant));
    },
  );

  // --- List the caller's tenants -------------------------------------------
  app.get(
    "",
    {
      preHandler: [app.requireAuth],
      schema: {
        tags: ["tenants"],
        summary: "List the tenants the caller belongs to",
        description: "Powers the tenant switcher. Only ACTIVE memberships are returned.",
        response: {
          200: z.object({
            items: z.array(tenantResponseSchema.extend({ role: z.string() })),
          }),
          ...commonErrorResponses,
        },
      },
    },
    async (request) => {
      const tenants = await service.listForUser(request.user!.id);
      return { items: tenants.map((tenant) => ({ ...toResponse(tenant), role: tenant.role })) };
    },
  );

  // --- Read the current tenant ---------------------------------------------
  app.get(
    "/current",
    {
      preHandler: [app.requirePermission(Permissions.TENANT_READ)],
      schema: {
        tags: ["tenants"],
        summary: "Read the tenant selected by the X-Tenant-Id header",
        response: { 200: tenantResponseSchema, ...commonErrorResponses },
      },
    },
    async (request) => {
      // requirePermission resolved and validated this.
      const tenant = await service.findById(request.tenant!.id);
      return toResponse(tenant!);
    },
  );

  // --- Update ---------------------------------------------------------------
  app.patch(
    "/current",
    {
      // Writability is checked before permission, so a suspended tenant rejects
      // even its owner.
      preHandler: [app.requireWritableTenant, app.requirePermission(Permissions.TENANT_MANAGE)],
      schema: {
        tags: ["tenants"],
        summary: "Update tenant settings",
        description:
          "Slug and status are intentionally not updatable: the slug is published in booking links, and status is a platform-admin operation.",
        body: updateTenantBodySchema,
        response: { 200: tenantResponseSchema, ...commonErrorResponses },
      },
    },
    async (request) => {
      const tenantId = request.tenant!.id;
      const before = await service.findById(tenantId);
      const updated = await service.update(tenantId, request.body);

      request.audit({
        action: "tenant.updated",
        entityType: "Tenant",
        entityId: tenantId,
        before: before ? toResponse(before) : undefined,
        after: toResponse(updated),
      });

      return toResponse(updated);
    },
  );

  // --- Switch active tenant -------------------------------------------------
  app.post(
    "/:tenantId/activate",
    {
      preHandler: [app.requireAuth],
      schema: {
        tags: ["tenants"],
        summary: "Set the session's active tenant",
        description:
          "Convenience for the tenant switcher. The stored value is never trusted for authorization — membership is re-checked on every request.",
        params: z.object({ tenantId: idSchema }),
        response: { 204: z.null(), ...commonErrorResponses },
      },
    },
    async (request, reply) => {
      const user = request.user!;

      // Membership is verified before storing, so the switcher cannot be used
      // to point a session at a tenant the user has no access to.
      const tenants = await service.listForUser(user.id);
      const target = tenants.find((tenant) => tenant.id === request.params.tenantId);

      if (!target) {
        // Same 404 as a nonexistent tenant — no enumeration oracle.
        return reply.callNotFound();
      }

      await service.setActiveTenant(user.id, target.id);
      return reply.status(204).send(null);
    },
  );
};
