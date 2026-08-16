import { z } from "zod";
import {
  currencySchema,
  dateOnlySchema,
  idSchema,
  instantSchema,
  languageSchema,
  minorAmountSchema,
  outsideScheduleSchema,
  paginationQuerySchema,
} from "@bam/contracts";

export const bookingStatusSchema = z.enum([
  "PENDING",
  "CONFIRMED",
  "CANCELLED",
  "COMPLETED",
  "NO_SHOW",
  "EXPIRED",
]);

export const bookingSourceSchema = z.enum(["FORM", "CHAT", "VOICE", "STAFF", "API"]);

/**
 * Who the appointment is for.
 *
 * `fullName` is the only required field: a front desk booking a walk-in has a
 * name and nothing else. The public form demands a contact detail as well —
 * that refinement lives in the public schemas, because it is a rule about
 * strangers rather than about customers (CLAUDE.md rule 12).
 */
export const customerInputSchema = z.object({
  fullName: z.string().trim().min(1).max(200),
  email: z.email().max(320).optional(),
  phone: z.string().trim().min(3).max(40).optional(),
  preferredLanguage: languageSchema.optional(),
  marketingConsent: z.boolean().optional(),
});

// ---------------------------------------------------------------------------
// Holds
// ---------------------------------------------------------------------------

export const createHoldBodySchema = z.object({
  serviceId: idSchema,
  providerId: idSchema,
  locationId: idSchema.optional(),
  /** The appointment's start. The diary block is derived from it and the
   *  service's buffers — the caller never sends the occupied window. */
  startAt: instantSchema,
  /**
   * Ties the hold to one browser tab or conversation. Client-generated, opaque,
   * and never trusted for authorization — it decides which hold a customer is
   * shown, not what they may do.
   */
  sessionId: z.string().trim().min(8).max(128),
});

export const holdResponseSchema = z.object({
  id: idSchema,
  providerId: idSchema,
  serviceId: idSchema,
  locationId: z.string().nullable(),
  startAt: instantSchema,
  endAt: instantSchema,
  expiresAt: instantSchema,
  /** What the countdown renders: "reserved for 4:38" (tech-impl §30 step 5). */
  remainingSeconds: z.number().int().min(0),
});

// ---------------------------------------------------------------------------
// Bookings
// ---------------------------------------------------------------------------

export const bookingResponseSchema = z.object({
  id: idSchema,
  reference: z.string(),
  status: bookingStatusSchema,
  source: bookingSourceSchema,

  providerId: idSchema,
  providerName: z.string(),
  serviceId: idSchema,
  locationId: z.string().nullable(),
  locationName: z.string().nullable(),
  customerId: idSchema,

  startAt: instantSchema,
  endAt: instantSchema,

  /** What the customer was told, not what the catalogue says now (§10.13). */
  customerName: z.string(),
  customerEmail: z.string().nullable(),
  customerPhone: z.string().nullable(),
  serviceName: z.string(),
  priceMinor: minorAmountSchema.nullable(),
  currency: currencySchema.nullable(),

  notes: z.string().nullable(),
  cancellationReason: z.string().nullable(),
  cancelledAt: instantSchema.nullable(),
  version: z.number().int(),
  createdAt: instantSchema,

  /**
   * Why this appointment sits outside its provider's current schedule, or null.
   * docs/phase-3-4-schedule-conflicts.md §2.6.
   *
   * Derived on read, never stored, and only ever non-null for a live future
   * booking — so it reads as "somebody should look at this", not as a fact about
   * history. Null on every single-booking response, where the question is not
   * asked: it is a property of a diary being scanned, not of a booking being
   * opened.
   */
  outsideSchedule: outsideScheduleSchema.default(null),
});

/**
 * Confirming a hold into a booking. tech-impl §11.5.
 *
 * The hold already fixes the provider, service, location and time — resending
 * them would invite a mismatch nobody could resolve, so the body carries only
 * what the hold does not know.
 */
export const confirmBookingBodySchema = z.object({
  holdId: idSchema,
  customer: customerInputSchema,
  notes: z.string().max(2000).optional(),
});

/**
 * A booking made directly from the diary, with no hold.
 *
 * Staff only. There is no five-minute form to protect, so the reservation and
 * the booking are written together in one transaction.
 */
export const createBookingBodySchema = z.object({
  providerId: idSchema,
  serviceId: idSchema,
  locationId: idSchema.optional(),
  startAt: instantSchema,
  customer: customerInputSchema,
  notes: z.string().max(2000).optional(),
  source: bookingSourceSchema.optional(),
});

/**
 * Editing a booking in place.
 *
 * Status changes are limited to the two that record what happened on the day.
 * Cancelling and rescheduling have their own endpoints because both move
 * capacity, and burying that inside a general-purpose PATCH is how a status
 * field ends up silently freeing somebody's appointment.
 */
export const updateBookingBodySchema = z.object({
  notes: z.string().max(2000).nullable().optional(),
  status: z.enum(["COMPLETED", "NO_SHOW", "CONFIRMED"]).optional(),
  /** From the copy the caller read. Guards two screens editing one booking. */
  version: z.number().int().min(0).optional(),
});

export const listBookingsQuerySchema = paginationQuerySchema.extend({
  providerId: idSchema.optional(),
  customerId: idSchema.optional(),
  status: z
    .union([bookingStatusSchema, z.array(bookingStatusSchema)])
    .transform((value) => (Array.isArray(value) ? value : [value]))
    .optional(),
  from: dateOnlySchema.optional(),
  to: dateOnlySchema.optional(),
});

// ---------------------------------------------------------------------------
// Reschedule and cancel
// ---------------------------------------------------------------------------

export const reschedulePrepareBodySchema = z.object({
  newStartAt: instantSchema,
  /** Moving to a different provider is a different appointment; not offered. */
  locationId: idSchema.optional(),
});

export const rescheduleConfirmBodySchema = reschedulePrepareBodySchema.extend({
  version: z.number().int().min(0).optional(),
});

export const cancelBodySchema = z.object({
  reason: z.string().max(500).optional(),
  version: z.number().int().min(0).optional(),
});

/**
 * What a prepare step returns. tech-impl §23.2.
 *
 * Prepare writes nothing. It exists so a confirmation screen — and, from Epic
 * 7, a chat or voice turn — can state exactly what is about to happen and be
 * sure the answer is not "that is not allowed" only after the customer agreed.
 */
export const reschedulePreviewSchema = z.object({
  bookingId: idSchema,
  reference: z.string(),
  current: z.object({ startAt: instantSchema, endAt: instantSchema }),
  proposed: z.object({ startAt: instantSchema, endAt: instantSchema }),
  providerName: z.string(),
  serviceName: z.string(),
  /** False with a reason when the move is refused; the screen says so up front. */
  allowed: z.boolean(),
  reason: z.string().nullable(),
});

export const cancellationPreviewSchema = z.object({
  bookingId: idSchema,
  reference: z.string(),
  startAt: instantSchema,
  endAt: instantSchema,
  providerName: z.string(),
  serviceName: z.string(),
  /** The tenant's policy text, so the customer sees it before agreeing. */
  cancellationPolicy: z.string().nullable(),
  allowed: z.boolean(),
  reason: z.string().nullable(),
});

/**
 * Declared so the header appears in the OpenAPI document, optional so the
 * refusal is ours.
 *
 * The header is genuinely required (tech-impl §32). Marking it required *here*
 * would have Fastify reject a missing one as a generic 422 VALIDATION_FAILED,
 * and §32 specifies IDEMPOTENCY_KEY_REQUIRED — a distinct code precisely
 * because "you forgot the retry-safety header" is a different fix from "your
 * body is wrong". `requireIdempotencyKey` enforces it and says so properly.
 */
export const idempotencyHeaderSchema = z.object({
  "idempotency-key": z
    .string()
    .min(1)
    .max(255)
    .optional()
    .describe("Required. Unique per action; a retry with the same key replays the first response."),
});

export type CustomerInput = z.infer<typeof customerInputSchema>;
export type CreateHoldBody = z.infer<typeof createHoldBodySchema>;
export type ConfirmBookingBody = z.infer<typeof confirmBookingBodySchema>;
export type CreateBookingBody = z.infer<typeof createBookingBodySchema>;
export type UpdateBookingBody = z.infer<typeof updateBookingBodySchema>;
export type ListBookingsQuery = z.infer<typeof listBookingsQuerySchema>;
export type ReschedulePrepareBody = z.infer<typeof reschedulePrepareBodySchema>;
export type RescheduleConfirmBody = z.infer<typeof rescheduleConfirmBodySchema>;
export type CancelBody = z.infer<typeof cancelBodySchema>;
export type BookingResponse = z.infer<typeof bookingResponseSchema>;
export type HoldResponse = z.infer<typeof holdResponseSchema>;
