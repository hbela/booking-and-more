import { z } from "zod";
import { currencySchema, idSchema, instantSchema, minorAmountSchema } from "@bam/contracts";
import { customerInputSchema } from "../bookings/booking.schemas.js";

/**
 * What a stranger may see and send. tech-impl §16, CLAUDE.md rule 12.
 *
 * Declared separately from the staff booking schemas rather than derived from
 * them, so that adding a staff field cannot quietly publish it. Compare
 * `publicBookingSchema` with `bookingResponseSchema`: no `version`, no
 * `source`, no internal `notes`, no `customerId`. A customer looking at their
 * own appointment does not need the tenant's operational metadata, and every
 * field that is not there is one that cannot leak.
 */

/**
 * The public form demands a way to reach the customer.
 *
 * Staff may book a walk-in with a name alone — they are standing there. A
 * booking made over the internet with no contact detail is one nobody can send
 * a confirmation to, remind, or tell about a cancellation.
 */
export const publicCustomerInputSchema = customerInputSchema.refine(
  (customer) => customer.email !== undefined || customer.phone !== undefined,
  { message: "An email address or a phone number is required.", path: ["email"] },
);

export const publicCreateHoldBodySchema = z.object({
  serviceId: idSchema,
  providerId: idSchema,
  locationId: idSchema.optional(),
  startAt: instantSchema,
  sessionId: z.string().trim().min(8).max(128),
});

export const publicHoldSchema = z.object({
  id: idSchema,
  providerId: idSchema,
  serviceId: idSchema,
  locationId: z.string().nullable(),
  startAt: instantSchema,
  endAt: instantSchema,
  expiresAt: instantSchema,
  remainingSeconds: z.number().int().min(0),
});

export const publicConfirmBookingBodySchema = z.object({
  holdId: idSchema,
  customer: publicCustomerInputSchema,
  /** The customer's own message to the clinic, not staff-internal notes. */
  notes: z.string().max(1000).optional(),
});

/** Statuses a customer is shown. The internal EXPIRED never appears. */
export const publicBookingStatusSchema = z.enum([
  "PENDING",
  "CONFIRMED",
  "CANCELLED",
  "COMPLETED",
  "NO_SHOW",
]);

export const publicBookingSchema = z.object({
  tenantSlug: z.string(),
  reference: z.string(),
  status: publicBookingStatusSchema,
  startAt: instantSchema,
  endAt: instantSchema,
  providerName: z.string(),
  serviceName: z.string(),
  locationName: z.string().nullable(),
  priceMinor: minorAmountSchema.nullable(),
  currency: currencySchema.nullable(),
  customerName: z.string(),
  cancellationPolicy: z.string().nullable(),
});

/**
 * The confirmation response, and the only time the raw management token exists
 * outside the customer's email.
 *
 * Only the SHA-256 hash is stored (tech-impl §34.4), so this value can never be
 * produced again — losing it means losing the link.
 */
export const publicBookingCreatedSchema = publicBookingSchema.extend({
  managementToken: z.string(),
});

export const managementTokenParamsSchema = z.object({
  // Not `idSchema`: this is 32 random bytes in base64url, not a model id.
  managementToken: z.string().min(20).max(200),
});

export const publicReschedulePrepareBodySchema = z.object({
  newStartAt: instantSchema,
});

export const publicReschedulePreviewSchema = z.object({
  reference: z.string(),
  current: z.object({ startAt: instantSchema, endAt: instantSchema }),
  proposed: z.object({ startAt: instantSchema, endAt: instantSchema }),
  providerName: z.string(),
  serviceName: z.string(),
  allowed: z.boolean(),
  /** A sentence for the customer, not the engine's reason code. */
  message: z.string().nullable(),
});

export const publicCancellationPreviewSchema = z.object({
  reference: z.string(),
  startAt: instantSchema,
  endAt: instantSchema,
  providerName: z.string(),
  serviceName: z.string(),
  cancellationPolicy: z.string().nullable(),
  allowed: z.boolean(),
  message: z.string().nullable(),
});

export const publicCancelBodySchema = z.object({
  reason: z.string().max(500).optional(),
});

export const releaseHoldQuerySchema = z.object({
  /** Proves the caller owns the hold they are releasing. */
  sessionId: z.string().trim().min(8).max(128),
});

export type PublicCreateHoldBody = z.infer<typeof publicCreateHoldBodySchema>;
export type PublicConfirmBookingBody = z.infer<typeof publicConfirmBookingBodySchema>;
export type PublicBooking = z.infer<typeof publicBookingSchema>;
