import { z } from "zod";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { Permissions, canBlockProviderTime } from "@bam/auth";
import { ForbiddenError, commonErrorResponses, idSchema } from "@bam/contracts";
import type { AvailabilityException, WorkingHours } from "@bam/db";
import { AvailabilityService } from "./availability.service.js";
import {
  createExceptionBodySchema,
  exceptionResponseSchema,
  listExceptionsQuerySchema,
  setWorkingHoursBodySchema,
  slotResponseSchema,
  slotSearchBodySchema,
  updateExceptionBodySchema,
  workingHoursResponseSchema,
} from "./availability.schemas.js";

function toWorkingHoursResponse(row: WorkingHours): z.infer<typeof workingHoursResponseSchema> {
  return {
    id: row.id,
    providerId: row.providerId,
    locationId: row.locationId,
    weekday: row.weekday,
    startTime: row.startTime,
    endTime: row.endTime,
    validFrom: row.validFrom ? row.validFrom.toISOString().slice(0, 10) : null,
    validUntil: row.validUntil ? row.validUntil.toISOString().slice(0, 10) : null,
    active: row.active,
  };
}

function toExceptionResponse(row: AvailabilityException): z.infer<typeof exceptionResponseSchema> {
  return {
    id: row.id,
    providerId: row.providerId,
    locationId: row.locationId,
    serviceId: row.serviceId,
    type: row.type,
    startAt: row.startAt.toISOString(),
    endAt: row.endAt.toISOString(),
    reason: row.reason,
    source: row.source,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Schedules and slot search. tech-impl §17.
 *
 * ## Where the `:own` permissions finally do something
 *
 * Epic 1 wrote `canBlockProviderTime` and tested it failing closed, because
 * `Membership.providerId` was always null. Epic 2 populated it. This module is
 * the first that actually asks: an ADMIN holds `availability:manage:all` and
 * may edit anyone's diary; a PROVIDER holds `availability:manage:own` and may
 * edit only the diary their membership is linked to.
 *
 * The route guard cannot express that on its own, because the answer depends on
 * *which* provider is in the URL. So the guard establishes tenant membership and
 * the handler asks the pure policy function about the specific resource — which
 * is exactly the split CLAUDE.md rule 10 describes.
 */
export const availabilityRoutes: FastifyPluginAsyncZod = async (app) => {
  const service = new AvailabilityService(app.prisma);

  /** 403 unless the actor may manage this particular provider's time. */
  function assertMayManage(
    request: { tenant?: { id: string }; actor?: unknown },
    providerId: string,
  ): void {
    const tenant = request.tenant!;
    const actor = request.actor as Parameters<typeof canBlockProviderTime>[0];

    if (!canBlockProviderTime(actor, tenant.id, providerId)) {
      // Deliberately not "that is not your diary": the caller learns only that
      // they may not, never whose it is.
      throw new ForbiddenError(
        "You do not have permission to manage this provider's availability.",
      );
    }
  }

  // --- Working hours --------------------------------------------------------
  app.get(
    "/providers/:providerId/working-hours",
    {
      preHandler: [app.requirePermission(Permissions.TENANT_READ)],
      schema: {
        tags: ["availability"],
        summary: "Read a provider's weekly working hours",
        description:
          "Local wall-clock times, interpreted in the provider's zone. Several rows per weekday are normal — a lunch break is a gap between two periods.",
        params: z.object({ providerId: idSchema }),
        response: {
          200: z.object({ items: z.array(workingHoursResponseSchema) }),
          ...commonErrorResponses,
        },
      },
    },
    async (request) => {
      const rows = await service.listWorkingHours({
        tenantId: request.tenant!.id,
        providerId: request.params.providerId,
      });

      return { items: rows.map(toWorkingHoursResponse) };
    },
  );

  app.put(
    "/providers/:providerId/working-hours",
    {
      // Only membership is asserted here; whose diary it is gets checked in the
      // handler, where the provider id is known.
      preHandler: [app.requireWritableTenant, app.requireTenant],
      schema: {
        tags: ["availability"],
        summary: "Replace a provider's weekly working hours",
        description:
          "Send the complete week. Anything omitted is removed. Providers may edit their own; administrators may edit anyone's.",
        params: z.object({ providerId: idSchema }),
        body: setWorkingHoursBodySchema,
        response: {
          200: z.object({ items: z.array(workingHoursResponseSchema) }),
          ...commonErrorResponses,
        },
      },
    },
    async (request) => {
      const tenantId = request.tenant!.id;
      const { providerId } = request.params;
      assertMayManage(request, providerId);

      const rows = await service.setWorkingHours({
        tenantId,
        providerId,
        entries: request.body.workingHours,
        acknowledgeAffectedBookings: request.body.acknowledgeAffectedBookings,
        now: new Date(),
      });

      request.audit({
        action: "availability.working_hours_changed",
        entityType: "Provider",
        entityId: providerId,
        after: {
          periods: rows.map((row) => `${String(row.weekday)} ${row.startTime}-${row.endTime}`),
        },
      });

      return { items: rows.map(toWorkingHoursResponse) };
    },
  );

  // --- Exceptions -----------------------------------------------------------
  app.get(
    "/providers/:providerId/availability-exceptions",
    {
      preHandler: [app.requirePermission(Permissions.TENANT_READ)],
      schema: {
        tags: ["availability"],
        summary: "List a provider's availability exceptions",
        description: "Defaults to the 90 days from today when no range is given.",
        params: z.object({ providerId: idSchema }),
        querystring: listExceptionsQuerySchema,
        response: {
          200: z.object({ items: z.array(exceptionResponseSchema) }),
          ...commonErrorResponses,
        },
      },
    },
    async (request) => {
      const { from, to } = request.query;
      const start = from ? new Date(`${from}T00:00:00Z`) : new Date();
      const end = to
        ? new Date(`${to}T23:59:59Z`)
        : new Date(start.getTime() + 90 * 24 * 60 * 60 * 1000);

      const rows = await service.listExceptions({
        tenantId: request.tenant!.id,
        providerId: request.params.providerId,
        from: start,
        to: end,
      });

      return { items: rows.map(toExceptionResponse) };
    },
  );

  app.post(
    "/providers/:providerId/availability-exceptions",
    {
      preHandler: [app.requireWritableTenant, app.requireTenant],
      schema: {
        tags: ["availability"],
        summary: "Block out time, or open extra time",
        description:
          "UNAVAILABLE removes time from the schedule; ADDITIONAL_AVAILABILITY adds it outside the recurring hours. Providers may do this to their own diary.",
        params: z.object({ providerId: idSchema }),
        body: createExceptionBodySchema,
        response: { 201: exceptionResponseSchema, ...commonErrorResponses },
      },
    },
    async (request, reply) => {
      const tenantId = request.tenant!.id;
      const { providerId } = request.params;
      assertMayManage(request, providerId);

      const exception = await service.createException({
        tenantId,
        providerId,
        input: request.body,
        createdByUserId: request.user?.id ?? null,
        now: new Date(),
      });

      request.audit({
        action: "availability.exception_created",
        entityType: "AvailabilityException",
        entityId: exception.id,
        // The reason is staff-private and stays out of the audit snapshot.
        after: {
          providerId,
          type: exception.type,
          startAt: exception.startAt.toISOString(),
          endAt: exception.endAt.toISOString(),
        },
      });

      return reply.status(201).send(toExceptionResponse(exception));
    },
  );

  app.patch(
    "/availability-exceptions/:exceptionId",
    {
      preHandler: [app.requireWritableTenant, app.requireTenant],
      schema: {
        tags: ["availability"],
        summary: "Update an availability exception",
        params: z.object({ exceptionId: idSchema }),
        body: updateExceptionBodySchema,
        response: { 200: exceptionResponseSchema, ...commonErrorResponses },
      },
    },
    async (request) => {
      const tenantId = request.tenant!.id;
      const { exceptionId } = request.params;

      // Loaded first: the permission depends on whose diary it is, which is a
      // property of the row rather than of the URL.
      const current = await service.repo.findExceptionOrThrow({ tenantId, exceptionId });
      assertMayManage(request, current.providerId);

      const updated = await service.updateException({
        tenantId,
        exceptionId,
        input: request.body,
        now: new Date(),
      });

      request.audit({
        action: "availability.exception_updated",
        entityType: "AvailabilityException",
        entityId: exceptionId,
        before: { startAt: current.startAt.toISOString(), endAt: current.endAt.toISOString() },
        after: { startAt: updated.startAt.toISOString(), endAt: updated.endAt.toISOString() },
      });

      return toExceptionResponse(updated);
    },
  );

  app.delete(
    "/availability-exceptions/:exceptionId",
    {
      preHandler: [app.requireWritableTenant, app.requireTenant],
      schema: {
        tags: ["availability"],
        summary: "Remove an availability exception",
        description:
          "A hard delete, unlike the catalogue: an exception is a statement about time that has not happened yet, and nothing points at it.",
        params: z.object({ exceptionId: idSchema }),
        response: { 204: z.null(), ...commonErrorResponses },
      },
    },
    async (request, reply) => {
      const tenantId = request.tenant!.id;
      const { exceptionId } = request.params;

      const current = await service.repo.findExceptionOrThrow({ tenantId, exceptionId });
      assertMayManage(request, current.providerId);

      await service.deleteException({ tenantId, exceptionId });

      request.audit({
        action: "availability.exception_deleted",
        entityType: "AvailabilityException",
        entityId: exceptionId,
        before: {
          providerId: current.providerId,
          startAt: current.startAt.toISOString(),
          endAt: current.endAt.toISOString(),
        },
      });

      return reply.status(204).send(null);
    },
  );

  // --- Staff slot search ----------------------------------------------------
  app.post(
    "/slots/search",
    {
      preHandler: [app.requirePermission(Permissions.TENANT_READ)],
      schema: {
        tags: ["availability"],
        summary: "Find bookable slots, as staff",
        description:
          "The same engine the public search uses, without the public filters — so the front desk can offer a slot with a provider who is not published online.",
        body: slotSearchBodySchema,
        response: {
          200: z.object({ items: z.array(slotResponseSchema) }),
          ...commonErrorResponses,
        },
      },
    },
    async (request) => {
      const slots = await service.searchSlots({
        tenantId: request.tenant!.id,
        input: request.body,
        now: new Date(),
        publicOnly: false,
      });

      return { items: slots };
    },
  );
};
