import { z } from "zod";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import type { FastifyRequest } from "fastify";
import { Permissions, can, canManageProviderBookings, canReadProviderBookings } from "@bam/auth";
import { ForbiddenError, commonErrorResponses, idSchema, paginatedSchema } from "@bam/contracts";
import { pageOf } from "../../lib/pagination.js";
import { requireIdempotencyKey, withIdempotency } from "../../lib/idempotency.js";
import { BookingService, type AuditContext } from "./booking.service.js";
import type { BookingWithRelations } from "./booking.repository.js";
import {
  bookingResponseSchema,
  cancelBodySchema,
  cancellationPreviewSchema,
  createBookingBodySchema,
  idempotencyHeaderSchema,
  listBookingsQuerySchema,
  reschedulePreviewSchema,
  rescheduleConfirmBodySchema,
  reschedulePrepareBodySchema,
  updateBookingBodySchema,
  type BookingResponse,
} from "./booking.schemas.js";

export function toBookingResponse(booking: BookingWithRelations): BookingResponse {
  return {
    id: booking.id,
    reference: booking.reference,
    status: booking.status,
    source: booking.source,
    providerId: booking.providerId,
    providerName: booking.provider.displayName,
    serviceId: booking.serviceId,
    locationId: booking.locationId,
    locationName: booking.location?.name ?? null,
    customerId: booking.customerId,
    startAt: booking.startAt.toISOString(),
    endAt: booking.endAt.toISOString(),
    customerName: booking.customerNameSnapshot,
    customerEmail: booking.customerEmailSnapshot,
    customerPhone: booking.customerPhoneSnapshot,
    serviceName: booking.serviceNameSnapshot,
    priceMinor: booking.priceMinorSnapshot,
    currency: booking.currencySnapshot,
    notes: booking.notes,
    cancellationReason: booking.cancellationReason,
    cancelledAt: booking.cancelledAt?.toISOString() ?? null,
    version: booking.version,
    createdAt: booking.createdAt.toISOString(),
  };
}

/** The audit identity of whoever is making this request. */
export function auditContextOf(request: FastifyRequest): AuditContext {
  return {
    actorType: request.user
      ? request.user.isPlatformAdmin
        ? "PLATFORM_ADMIN"
        : "USER"
      : "CUSTOMER",
    actorId: request.user?.id ?? null,
    requestId: request.context?.requestId ?? null,
    ipAddress: request.ip,
    userAgent: request.headers["user-agent"] ?? null,
  };
}

/**
 * Staff booking management. tech-impl §17.
 *
 * ## Two permissions, resolved per resource
 *
 * `booking:read:all` / `booking:manage:all` let the front desk work across the
 * whole diary; the `:own` pair limits a provider to their own. As with
 * availability in Epic 3, the route guard cannot decide alone — the answer
 * depends on *which* provider's booking is being touched — so the guard
 * establishes membership and the handler asks the pure policy function about
 * the specific row.
 */
export const bookingRoutes: FastifyPluginAsyncZod = async (app) => {
  const service = new BookingService(app.prisma);

  function assertMayRead(request: FastifyRequest, providerId: string): void {
    const tenant = request.tenant!;
    const actor = request.actor as Parameters<typeof canReadProviderBookings>[0];

    if (!canReadProviderBookings(actor, tenant.id, providerId)) {
      throw new ForbiddenError("You do not have permission to view this booking.");
    }
  }

  function assertMayManage(request: FastifyRequest, providerId: string): void {
    const tenant = request.tenant!;
    const actor = request.actor as Parameters<typeof canManageProviderBookings>[0];

    if (!canManageProviderBookings(actor, tenant.id, providerId)) {
      throw new ForbiddenError("You do not have permission to change this booking.");
    }
  }

  /** Load, then check: whose booking it is is a property of the row. */
  async function loadForRead(request: FastifyRequest, bookingId: string) {
    const booking = await service.repo.findByIdOrThrow({
      tenantId: request.tenant!.id,
      bookingId,
    });
    assertMayRead(request, booking.providerId);
    return booking;
  }

  async function loadForManage(request: FastifyRequest, bookingId: string) {
    const booking = await service.repo.findByIdOrThrow({
      tenantId: request.tenant!.id,
      bookingId,
    });
    assertMayManage(request, booking.providerId);
    return booking;
  }

  // --- List and read --------------------------------------------------------

  app.get(
    "/",
    {
      preHandler: [app.requireTenant],
      schema: {
        tags: ["bookings"],
        summary: "List bookings",
        description:
          "A provider sees only their own diary; the front desk sees everyone's. Ordered by start time.",
        querystring: listBookingsQuerySchema,
        response: {
          200: paginatedSchema(bookingResponseSchema),
          ...commonErrorResponses,
        },
      },
    },
    async (request) => {
      const tenant = request.tenant!;
      const actor = request.actor as Parameters<typeof canReadProviderBookings>[0];
      const query = request.query;

      // A caller holding only `:own` is narrowed to their own diary rather than
      // refused: "show me my bookings" is the request they meant, and a 403 for
      // omitting a filter they cannot know to send would be unhelpful.
      //
      // A provider whose membership is not linked to a diary is refused
      // outright. Leaving the filter unset for them would list the whole tenant
      // — an unpopulated field must never widen access (CLAUDE.md rule 10).
      let providerId = query.providerId;

      if (providerId === undefined) {
        if (!can(actor, tenant.id, Permissions.BOOKING_READ_ALL)) {
          const own = actor.membership?.providerId;
          if (own === undefined) {
            throw new ForbiddenError("You do not have permission to view bookings.");
          }
          providerId = own;
        }
      } else {
        assertMayRead(request, providerId);
      }

      const rows = await service.repo.list({
        tenantId: tenant.id,
        limit: query.limit,
        cursor: query.cursor,
        providerId,
        customerId: query.customerId,
        status: query.status,
        from: query.from === undefined ? undefined : new Date(`${query.from}T00:00:00Z`),
        to: query.to === undefined ? undefined : new Date(`${query.to}T23:59:59.999Z`),
      });

      return pageOf(rows, query.limit, (row) => row.startAt.toISOString(), toBookingResponse);
    },
  );

  app.get(
    "/:bookingId",
    {
      preHandler: [app.requireTenant],
      schema: {
        tags: ["bookings"],
        summary: "Read one booking",
        params: z.object({ bookingId: idSchema }),
        response: { 200: bookingResponseSchema, ...commonErrorResponses },
      },
    },
    async (request) => toBookingResponse(await loadForRead(request, request.params.bookingId)),
  );

  // --- Create ---------------------------------------------------------------

  app.post(
    "/",
    {
      preHandler: [app.requireWritableTenant, app.requireTenant],
      schema: {
        tags: ["bookings"],
        summary: "Book an appointment from the diary",
        description:
          "No hold: staff are already at the screen. The notice and advance windows do not apply — the business decides its own diary — but the slot must still be inside working hours and the exclusion constraint still refuses a double booking.",
        headers: idempotencyHeaderSchema,
        body: createBookingBodySchema,
        response: {
          201: bookingResponseSchema.extend({
            managementToken: z
              .string()
              .describe("Shown once. The customer's link to manage this booking."),
          }),
          ...commonErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const tenant = request.tenant!;
      assertMayManage(request, request.body.providerId);

      const key = requireIdempotencyKey(request.headers);

      const { value } = await withIdempotency(
        app.prisma,
        {
          tenantId: tenant.id,
          operation: "bookings.create",
          key,
          requestBody: request.body,
          successStatus: 201,
        },
        async () => {
          const created = await service.createDirectBooking({
            tenantId: tenant.id,
            input: request.body,
            now: new Date(),
            createdByUserId: request.user?.id ?? null,
            audit: auditContextOf(request),
          });

          return {
            ...toBookingResponse(created.booking),
            managementToken: created.managementToken,
          };
        },
      );

      return reply.status(201).send(value);
    },
  );

  // --- Edit -----------------------------------------------------------------

  app.patch(
    "/:bookingId",
    {
      preHandler: [app.requireWritableTenant, app.requireTenant],
      schema: {
        tags: ["bookings"],
        summary: "Update notes, or record what happened",
        description:
          "COMPLETED and NO_SHOW only. Cancelling and rescheduling move capacity and have their own endpoints.",
        params: z.object({ bookingId: idSchema }),
        body: updateBookingBodySchema,
        response: { 200: bookingResponseSchema, ...commonErrorResponses },
      },
    },
    async (request) => {
      const booking = await loadForManage(request, request.params.bookingId);

      return toBookingResponse(
        await service.updateBooking({
          tenantId: request.tenant!.id,
          bookingId: booking.id,
          input: request.body,
          audit: auditContextOf(request),
        }),
      );
    },
  );

  // --- Reschedule -----------------------------------------------------------

  app.post(
    "/:bookingId/reschedule/prepare",
    {
      preHandler: [app.requireTenant],
      schema: {
        tags: ["bookings"],
        summary: "Preview a move",
        description:
          "Writes nothing. Says up front whether the move is permitted, so a confirmation screen never asks somebody to agree to something that will then be refused.",
        params: z.object({ bookingId: idSchema }),
        body: reschedulePrepareBodySchema,
        response: { 200: reschedulePreviewSchema, ...commonErrorResponses },
      },
    },
    async (request) => {
      const booking = await loadForManage(request, request.params.bookingId);

      const preview = await service.prepareReschedule({
        tenantId: request.tenant!.id,
        bookingId: booking.id,
        input: request.body,
        now: new Date(),
      });

      return {
        bookingId: booking.id,
        reference: booking.reference,
        current: {
          startAt: booking.startAt.toISOString(),
          endAt: booking.endAt.toISOString(),
        },
        proposed: preview.proposed,
        providerName: booking.provider.displayName,
        serviceName: booking.serviceNameSnapshot,
        allowed: preview.decision.allowed,
        reason: preview.decision.allowed ? null : preview.decision.reason,
      };
    },
  );

  app.post(
    "/:bookingId/reschedule/confirm",
    {
      preHandler: [app.requireWritableTenant, app.requireTenant],
      schema: {
        tags: ["bookings"],
        summary: "Move a booking",
        description:
          "One transaction. The existing reservation is moved rather than released and re-acquired, so a collision leaves the booking exactly where it was.",
        params: z.object({ bookingId: idSchema }),
        headers: idempotencyHeaderSchema,
        body: rescheduleConfirmBodySchema,
        response: { 200: bookingResponseSchema, ...commonErrorResponses },
      },
    },
    async (request) => {
      const booking = await loadForManage(request, request.params.bookingId);
      const key = requireIdempotencyKey(request.headers);

      const { value } = await withIdempotency(
        app.prisma,
        {
          tenantId: request.tenant!.id,
          operation: "bookings.reschedule",
          key,
          requestBody: { bookingId: booking.id, ...request.body },
          successStatus: 200,
        },
        async () =>
          toBookingResponse(
            await service.confirmReschedule({
              tenantId: request.tenant!.id,
              bookingId: booking.id,
              input: request.body,
              now: new Date(),
              audit: auditContextOf(request),
            }),
          ),
      );

      return value;
    },
  );

  // --- Cancel ---------------------------------------------------------------

  app.post(
    "/:bookingId/cancel/prepare",
    {
      preHandler: [app.requireTenant],
      schema: {
        tags: ["bookings"],
        summary: "Preview a cancellation",
        params: z.object({ bookingId: idSchema }),
        response: { 200: cancellationPreviewSchema, ...commonErrorResponses },
      },
    },
    async (request) => {
      const booking = await loadForManage(request, request.params.bookingId);

      const preview = await service.prepareCancellation({
        tenantId: request.tenant!.id,
        bookingId: booking.id,
        now: new Date(),
      });

      // Read separately: ResolvedTenant deliberately carries only what every
      // request needs to decide access, and a policy string is not that.
      const tenant = await app.prisma.tenant.findUnique({
        where: { id: request.tenant!.id },
        select: { cancellationPolicy: true },
      });

      return {
        bookingId: booking.id,
        reference: booking.reference,
        startAt: booking.startAt.toISOString(),
        endAt: booking.endAt.toISOString(),
        providerName: booking.provider.displayName,
        serviceName: booking.serviceNameSnapshot,
        cancellationPolicy: tenant?.cancellationPolicy ?? null,
        allowed: preview.decision.allowed,
        reason: preview.decision.allowed ? null : preview.decision.reason,
      };
    },
  );

  app.post(
    "/:bookingId/cancel/confirm",
    {
      preHandler: [app.requireWritableTenant, app.requireTenant],
      schema: {
        tags: ["bookings"],
        summary: "Cancel a booking",
        description:
          "Releases the reservation, so the slot returns to sale as the transaction commits.",
        params: z.object({ bookingId: idSchema }),
        headers: idempotencyHeaderSchema,
        body: cancelBodySchema,
        response: { 200: bookingResponseSchema, ...commonErrorResponses },
      },
    },
    async (request) => {
      const booking = await loadForManage(request, request.params.bookingId);
      const key = requireIdempotencyKey(request.headers);

      const { value } = await withIdempotency(
        app.prisma,
        {
          tenantId: request.tenant!.id,
          operation: "bookings.cancel",
          key,
          requestBody: { bookingId: booking.id, ...request.body },
          successStatus: 200,
        },
        async () =>
          toBookingResponse(
            await service.confirmCancellation({
              tenantId: request.tenant!.id,
              bookingId: booking.id,
              input: request.body,
              now: new Date(),
              audit: auditContextOf(request),
            }),
          ),
      );

      return value;
    },
  );
};
