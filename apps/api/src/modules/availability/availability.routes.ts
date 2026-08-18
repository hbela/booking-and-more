import { z } from "zod";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { Permissions, canBlockProviderTime, canReadProviderBookings } from "@bam/auth";
import { ForbiddenError, commonErrorResponses, idSchema } from "@bam/contracts";
import type { AvailabilityException, WorkingHours } from "@bam/db";
import { AvailabilityService } from "./availability.service.js";
import {
  createExceptionBodySchema,
  exceptionResponseSchema,
  listExceptionsQuerySchema,
  scheduleLastChangeSchema,
  setWorkingHoursBodySchema,
  slotResponseSchema,
  slotSearchBodySchema,
  updateExceptionBodySchema,
  workingHoursResponseSchema,
} from "./availability.schemas.js";
import {
  fingerprintWorkingHours,
  requireScheduleFingerprint,
} from "./working-hours-fingerprint.js";

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
 *
 * Since docs/phase-3-4-diary-delegation.md there is a third answer: a member
 * holding `availability:manage:delegated` may edit the diaries handed to them.
 * Nothing in this file changed for it — `canBlockProviderTime` grew the branch,
 * which is the entire point of asking a named rule rather than comparing ids
 * here. What *did* change is that both reads now ask the same question the
 * writes ask (§2.9); they were `TENANT_READ`, which every staff role holds.
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

  /**
   * May the actor also *read* this diary's bookings?
   *
   * A separate question from `assertMayManage` since diary delegation, because
   * a grant may cover availability without covering bookings. It decides only
   * whether the stranded-bookings payload carries customer names — never
   * whether the save proceeds (docs/phase-3-4-diary-delegation.md §2.12).
   */
  function mayReadBookings(
    request: { tenant?: { id: string }; actor?: unknown },
    providerId: string,
  ): boolean {
    const tenant = request.tenant!;
    const actor = request.actor as Parameters<typeof canReadProviderBookings>[0];

    return canReadProviderBookings(actor, tenant.id, providerId);
  }

  // --- Working hours --------------------------------------------------------
  app.get(
    "/providers/:providerId/working-hours",
    {
      // Asks the same question the write asks (§2.9 of the delegation record).
      // It was `TENANT_READ` until 2026-08-17, which every staff role holds — so
      // any member could read any provider's schedule. Narrowed because
      // otherwise an assistant with no grant still reads every diary in the
      // organization and is merely unable to save.
      preHandler: [app.requireTenant],
      schema: {
        tags: ["availability"],
        summary: "Read a provider's weekly working hours",
        description:
          "Local wall-clock times, interpreted in the provider's zone. Several rows per weekday are normal — a lunch break is a gap between two periods. Readable by whoever may change them: the provider, an administrator, or a member the diary has been delegated to. `lastChange` names whoever saved the week last, so a provider and their assistant can see each other's edits — null until somebody saves one.",
        params: z.object({ providerId: idSchema }),
        response: {
          200: z.object({
            items: z.array(workingHoursResponseSchema),
            lastChange: scheduleLastChangeSchema.nullable(),
            fingerprint: z
              .string()
              .describe(
                "Send this back as `expectedFingerprint` on the PUT. It identifies the version of the week these rows are, and the save is refused if it has moved.",
              ),
          }),
          ...commonErrorResponses,
        },
      },
    },
    async (request) => {
      const tenantId = request.tenant!.id;
      const { providerId } = request.params;
      assertMayManage(request, providerId);

      // On the same response rather than an endpoint of its own: it describes
      // exactly the set being returned, and a second request would let the two
      // disagree — the screen would show a week from one moment attributed to a
      // save from another.
      const [rows, lastChange] = await Promise.all([
        service.listWorkingHours({ tenantId, providerId }),
        service.lastWorkingHoursChange({ tenantId, providerId }),
      ]);

      return {
        items: rows.map(toWorkingHoursResponse),
        lastChange:
          lastChange === null ? null : { at: lastChange.at.toISOString(), by: lastChange.by },
        // Computed from the rows just returned, so the caller's body and the
        // version it claims to replace can never describe different reads.
        fingerprint: fingerprintWorkingHours(rows),
      };
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
          "Send the complete week. Anything omitted is removed. Providers may edit their own; administrators may edit anyone's. `expectedFingerprint` is required and must come from a current GET of this same set: if somebody else has saved since, the request is refused with SCHEDULE_MODIFIED and details naming them, rather than silently reverting their work.",
        params: z.object({ providerId: idSchema }),
        body: setWorkingHoursBodySchema,
        response: {
          200: z.object({
            items: z.array(workingHoursResponseSchema),
            fingerprint: z.string().describe("The new version, for a follow-up save."),
          }),
          ...commonErrorResponses,
        },
      },
    },
    async (request) => {
      const tenantId = request.tenant!.id;
      const { providerId } = request.params;
      assertMayManage(request, providerId);

      // After the permission check, deliberately: see the note on
      // `expectedFingerprint` in the body schema.
      const expectedFingerprint = requireScheduleFingerprint(request.body.expectedFingerprint);

      const rows = await service.setWorkingHours({
        tenantId,
        providerId,
        entries: request.body.workingHours,
        acknowledgeAffectedBookings: request.body.acknowledgeAffectedBookings,
        mayReadBookings: mayReadBookings(request, providerId),
        expectedFingerprint,
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

      // The version the caller now holds, so a second save needs no extra GET.
      return { items: rows.map(toWorkingHoursResponse), fingerprint: fingerprintWorkingHours(rows) };
    },
  );

  // --- Exceptions -----------------------------------------------------------
  app.get(
    "/providers/:providerId/availability-exceptions",
    {
      // Narrowed with the working-hours read, and with more at stake: `reason`
      // is staff-private enough to be kept out of the audit snapshot below, and
      // `TENANT_READ` published every provider's closure reasons to every
      // member of the organization.
      preHandler: [app.requireTenant],
      schema: {
        tags: ["availability"],
        summary: "List a provider's availability exceptions",
        description:
          "Defaults to the 90 days from today when no range is given. Readable by whoever may change them.",
        params: z.object({ providerId: idSchema }),
        querystring: listExceptionsQuerySchema,
        response: {
          200: z.object({ items: z.array(exceptionResponseSchema) }),
          ...commonErrorResponses,
        },
      },
    },
    async (request) => {
      const { providerId } = request.params;
      assertMayManage(request, providerId);

      const { from, to } = request.query;
      const start = from ? new Date(`${from}T00:00:00Z`) : new Date();
      const end = to
        ? new Date(`${to}T23:59:59Z`)
        : new Date(start.getTime() + 90 * 24 * 60 * 60 * 1000);

      const rows = await service.listExceptions({
        tenantId: request.tenant!.id,
        providerId,
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
        mayReadBookings: mayReadBookings(request, providerId),
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
        mayReadBookings: mayReadBookings(request, current.providerId),
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
  //
  // Stays on TENANT_READ while both reads above were narrowed, and that is not
  // an inconsistency (delegation record §2.9). A receptionist holding one
  // provider's diary still has to answer "when could somebody see me this
  // week", and a search that silently omitted the providers they are not
  // delegated for would return a *wrong* answer rather than a narrower one —
  // the worst failure available, because it looks like a full answer.
  //
  // What it exposes is free/busy, strictly less than the public booking page
  // already shows a stranger. The write stays closed: POST /v1/bookings asks
  // canManageProviderBookings about the body's provider, so finding a slot on
  // an undelegated diary and trying to book it is a 403.
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
