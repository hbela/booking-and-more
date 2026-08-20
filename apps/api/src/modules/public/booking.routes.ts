import { z } from "zod";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import type { Tenant } from "@bam/db";
import { ErrorCodes, NotFoundError, commonErrorResponses, idSchema } from "@bam/contracts";
import { holdRemainingSeconds } from "@bam/booking-engine";
import { requireIdempotencyKey, withIdempotency } from "../../lib/idempotency.js";
import { BookingService } from "../bookings/booking.service.js";
import { auditContextOf } from "../bookings/booking.routes.js";
import { idempotencyHeaderSchema } from "../bookings/booking.schemas.js";
import type { BookingWithRelations } from "../bookings/booking.repository.js";
import { PublicCatalogueService } from "./catalogue.service.js";
import { tenantSlugParamsSchema } from "./catalogue.schemas.js";
import {
  managementTokenParamsSchema,
  publicBookingCreatedSchema,
  publicBookingSchema,
  publicCancelBodySchema,
  publicCancellationPreviewSchema,
  publicConfirmBookingBodySchema,
  publicCreateHoldBodySchema,
  publicHoldSchema,
  publicReschedulePrepareBodySchema,
  publicReschedulePreviewSchema,
  releaseHoldQuerySchema,
  type PublicBooking,
} from "./booking.schemas.js";

/**
 * Booking, for people with no account. tech-impl §16, §30.
 *
 * ## What authorises these requests
 *
 * Nothing, until a booking exists. Anyone can search slots and take a hold —
 * that is what a public booking page is — so the protections are the tenant
 * slug (which selects a tenant that accepts bookings at all), the `publicOnly`
 * filters (which decide what may be booked), rate limits, and the capacity
 * constraint.
 *
 * Afterwards, a management token does. It is 32 random bytes, stored only as a
 * SHA-256 hash, and it both identifies the booking and proves the caller is
 * entitled to it — so it is checked in constant work by a unique-index lookup
 * and never compared against a list.
 */
export const publicBookingRoutes: FastifyPluginAsyncZod = async (app) => {
  const catalogue = new PublicCatalogueService(app.prisma);
  const bookings = new BookingService(app.prisma);

  /** Writes are rarer and much more expensive than reads. tech-impl §33. */
  const writeRateLimit = { rateLimit: { max: 20, timeWindow: "1 minute" } };

  function toPublicBooking(booking: BookingWithRelations, tenant: Tenant): PublicBooking {
    return {
      tenantSlug: tenant.slug,
      reference: booking.reference,
      // EXPIRED is an internal outcome — a request nobody acted on. Showing a
      // customer a status the schema does not admit would fail serialization,
      // which is the loud failure we want rather than a leaked internal state.
      status: booking.status === "EXPIRED" ? "CANCELLED" : booking.status,
      startAt: booking.startAt.toISOString(),
      endAt: booking.endAt.toISOString(),
      providerName: booking.provider.displayName,
      serviceName: booking.serviceNameSnapshot,
      locationName: booking.location?.name ?? null,
      priceMinor: booking.priceMinorSnapshot,
      currency: booking.currencySnapshot,
      customerName: booking.customerNameSnapshot,
      cancellationPolicy: tenant.cancellationPolicy,
    };
  }

  /**
   * Resolve a management token to its booking and tenant.
   *
   * A bad token and a token for a tenant that has stopped taking bookings give
   * the same 404 — there is nothing to learn from the difference.
   */
  async function fromToken(
    token: string,
  ): Promise<{ booking: BookingWithRelations; tenant: Tenant }> {
    const booking = await bookings.repo.findByManagementToken(token);
    if (!booking) throw bookingLinkNotFound();

    const tenant = await app.prisma.tenant.findUnique({ where: { id: booking.tenantId } });
    if (!tenant) throw bookingLinkNotFound();

    return { booking, tenant };
  }

  // --- Holds ----------------------------------------------------------------

  app.post(
    "/tenants/:tenantSlug/holds",
    {
      config: writeRateLimit,
      schema: {
        tags: ["public"],
        summary: "Reserve a slot while the customer fills in the form",
        description:
          "Held for five minutes. Prevents anyone else — customer or staff — taking the slot in the meantime.",
        params: tenantSlugParamsSchema,
        headers: idempotencyHeaderSchema,
        body: publicCreateHoldBodySchema,
        response: { 201: publicHoldSchema, ...commonErrorResponses },
      },
    },
    async (request, reply) => {
      const tenant = await catalogue.resolveTenant(request.params.tenantSlug);
      const key = requireIdempotencyKey(request.headers);

      const now = new Date();

      const { value } = await withIdempotency(
        app.prisma,
        {
          tenantId: tenant.id,
          operation: "public.holds.create",
          key,
          requestBody: request.body,
          successStatus: 201,
        },
        async () => {
          const { hold } = await bookings.createHold({
            tenantId: tenant.id,
            input: request.body,
            now,
            publicOnly: true,
          });

          return {
            id: hold.id,
            providerId: hold.providerId,
            serviceId: hold.serviceId,
            locationId: hold.locationId,
            startAt: hold.startAt.toISOString(),
            endAt: hold.endAt.toISOString(),
            expiresAt: hold.expiresAt.toISOString(),
            remainingSeconds: holdRemainingSeconds(
              { expiresAt: hold.expiresAt.toISOString() },
              now.toISOString(),
            ),
          };
        },
      );

      // Recomputed on a replay: a countdown restored from a stored response
      // would tell a customer they have five minutes when they have forty
      // seconds.
      return reply.status(201).send({
        ...value,
        remainingSeconds: holdRemainingSeconds(
          { expiresAt: value.expiresAt },
          new Date().toISOString(),
        ),
      });
    },
  );

  app.delete(
    "/tenants/:tenantSlug/holds/:holdId",
    {
      config: writeRateLimit,
      schema: {
        tags: ["public"],
        summary: "Give a slot back",
        description: "What the booking page calls when the customer steps back from the form.",
        params: tenantSlugParamsSchema.extend({ holdId: idSchema }),
        querystring: releaseHoldQuerySchema,
        response: { 204: z.null(), ...commonErrorResponses },
      },
    },
    async (request, reply) => {
      const tenant = await catalogue.resolveTenant(request.params.tenantSlug);

      await bookings.releaseHold({
        tenantId: tenant.id,
        holdId: request.params.holdId,
        sessionId: request.query.sessionId,
      });

      return reply.status(204).send(null);
    },
  );

  // --- Confirmation ---------------------------------------------------------

  app.post(
    "/tenants/:tenantSlug/bookings",
    {
      config: writeRateLimit,
      schema: {
        tags: ["public"],
        summary: "Confirm a held slot",
        description:
          "Returns the management token once and only once — it is stored as a hash and cannot be reissued.",
        params: tenantSlugParamsSchema,
        headers: idempotencyHeaderSchema,
        body: publicConfirmBookingBodySchema,
        response: { 201: publicBookingCreatedSchema, ...commonErrorResponses },
      },
    },
    async (request, reply) => {
      const tenant = await catalogue.resolveTenant(request.params.tenantSlug);
      const key = requireIdempotencyKey(request.headers);

      // This response contains the raw management credential and represents
      // the booking's current status. Neither browsers nor intermediaries may
      // retain it.
      reply.header("Cache-Control", "private, no-store");

      const { value } = await withIdempotency(
        app.prisma,
        {
          tenantId: tenant.id,
          operation: "public.bookings.create",
          key,
          requestBody: request.body,
          successStatus: 201,
        },
        async () => {
          const created = await bookings.confirmBooking({
            tenantId: tenant.id,
            input: request.body,
            now: new Date(),
            source: "FORM",
            createdByUserId: null,
            audit: auditContextOf(request),
          });

          return {
            ...toPublicBooking(created.booking, tenant),
            managementToken: created.managementToken,
          };
        },
      );

      return reply.status(201).send(value);
    },
  );

  // --- Managing an existing booking -----------------------------------------

  app.get(
    "/bookings/:managementToken",
    {
      schema: {
        tags: ["public"],
        summary: "Look up a booking by its management link",
        params: managementTokenParamsSchema,
        response: { 200: publicBookingSchema, ...commonErrorResponses },
      },
    },
    async (request, reply) => {
      // The success screen polls this endpoint while approval is outstanding.
      // A cached PENDING response would leave the customer page stale after
      // staff (or the automatic policy) confirms the booking.
      reply.header("Cache-Control", "private, no-store");
      const { booking, tenant } = await fromToken(request.params.managementToken);
      return toPublicBooking(booking, tenant);
    },
  );

  app.post(
    "/bookings/:managementToken/reschedule/prepare",
    {
      config: writeRateLimit,
      schema: {
        tags: ["public"],
        summary: "Check whether a new time is possible",
        params: managementTokenParamsSchema,
        body: publicReschedulePrepareBodySchema,
        response: { 200: publicReschedulePreviewSchema, ...commonErrorResponses },
      },
    },
    async (request) => {
      const { booking } = await fromToken(request.params.managementToken);

      const preview = await bookings.prepareReschedule({
        tenantId: booking.tenantId,
        bookingId: booking.id,
        input: request.body,
        now: new Date(),
      });

      return {
        reference: booking.reference,
        current: { startAt: booking.startAt.toISOString(), endAt: booking.endAt.toISOString() },
        proposed: preview.proposed,
        providerName: booking.provider.displayName,
        serviceName: booking.serviceNameSnapshot,
        allowed: preview.decision.allowed,
        message: preview.decision.allowed ? null : customerMessageFor(preview.decision.reason),
      };
    },
  );

  app.post(
    "/bookings/:managementToken/reschedule/confirm",
    {
      config: writeRateLimit,
      schema: {
        tags: ["public"],
        summary: "Move a booking to a new time",
        params: managementTokenParamsSchema,
        headers: idempotencyHeaderSchema,
        body: publicReschedulePrepareBodySchema,
        response: { 200: publicBookingSchema, ...commonErrorResponses },
      },
    },
    async (request) => {
      const { booking, tenant } = await fromToken(request.params.managementToken);
      const key = requireIdempotencyKey(request.headers);

      const { value } = await withIdempotency(
        app.prisma,
        {
          tenantId: booking.tenantId,
          operation: "public.bookings.reschedule",
          key,
          requestBody: { bookingId: booking.id, ...request.body },
          successStatus: 200,
        },
        async () =>
          toPublicBooking(
            await bookings.confirmReschedule({
              tenantId: booking.tenantId,
              bookingId: booking.id,
              input: request.body,
              now: new Date(),
              audit: auditContextOf(request),
            }),
            tenant,
          ),
      );

      return value;
    },
  );

  app.post(
    "/bookings/:managementToken/cancel/prepare",
    {
      config: writeRateLimit,
      schema: {
        tags: ["public"],
        summary: "Show what cancelling would mean",
        params: managementTokenParamsSchema,
        response: { 200: publicCancellationPreviewSchema, ...commonErrorResponses },
      },
    },
    async (request) => {
      const { booking, tenant } = await fromToken(request.params.managementToken);

      const preview = await bookings.prepareCancellation({
        tenantId: booking.tenantId,
        bookingId: booking.id,
        now: new Date(),
      });

      return {
        reference: booking.reference,
        startAt: booking.startAt.toISOString(),
        endAt: booking.endAt.toISOString(),
        providerName: booking.provider.displayName,
        serviceName: booking.serviceNameSnapshot,
        cancellationPolicy: tenant.cancellationPolicy,
        allowed: preview.decision.allowed,
        message: preview.decision.allowed ? null : customerMessageFor(preview.decision.reason),
      };
    },
  );

  app.post(
    "/bookings/:managementToken/cancel/confirm",
    {
      config: writeRateLimit,
      schema: {
        tags: ["public"],
        summary: "Cancel a booking",
        params: managementTokenParamsSchema,
        headers: idempotencyHeaderSchema,
        body: publicCancelBodySchema,
        response: { 200: publicBookingSchema, ...commonErrorResponses },
      },
    },
    async (request) => {
      const { booking, tenant } = await fromToken(request.params.managementToken);
      const key = requireIdempotencyKey(request.headers);

      const { value } = await withIdempotency(
        app.prisma,
        {
          tenantId: booking.tenantId,
          operation: "public.bookings.cancel",
          key,
          requestBody: { bookingId: booking.id, ...request.body },
          successStatus: 200,
        },
        async () =>
          toPublicBooking(
            await bookings.confirmCancellation({
              tenantId: booking.tenantId,
              bookingId: booking.id,
              input: request.body,
              now: new Date(),
              audit: auditContextOf(request),
            }),
            tenant,
          ),
      );

      return value;
    },
  );
};

/**
 * Reason codes are for clients; this is for people.
 *
 * The engine's vocabulary ("TOO_LATE_TO_CANCEL") is stable and machine-facing.
 * A customer reading their booking page needs a sentence, and one that does not
 * expose which internal rule they tripped.
 */
function customerMessageFor(reason: string): string {
  switch (reason) {
    case "ALREADY_STARTED":
      return "This appointment has already started. Please call us.";
    case "BOOKING_ALREADY_CANCELLED":
      return "This appointment has already been cancelled.";
    case "BOOKING_TERMINAL":
      return "This appointment is finished and can no longer be changed.";
    case "TOO_LATE_TO_CANCEL":
      return "It is too late to change this appointment online. Please call us.";
    case "MINIMUM_NOTICE_NOT_MET":
      return "That time is too soon. Please choose a later one.";
    case "OUTSIDE_BOOKING_WINDOW":
      return "That date is further ahead than we take bookings.";
    case "SAME_TIME":
      return "That is the time the appointment is already booked for.";
    case "IN_THE_PAST":
      return "That time has already passed.";
    default:
      return "That change is not possible. Please call us.";
  }
}

/**
 * One 404 for every way a management link can fail to resolve: wrong token,
 * deleted booking, tenant no longer taking bookings. A link is a credential,
 * and distinguishing "no such token" from "that token belongs to a closed
 * clinic" turns the endpoint into an oracle for probing them.
 */
function bookingLinkNotFound(): NotFoundError {
  return new NotFoundError(
    "This booking link is not valid. It may have expired.",
    ErrorCodes.BOOKING_NOT_FOUND,
  );
}
