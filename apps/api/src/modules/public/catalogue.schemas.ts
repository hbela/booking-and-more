import { z } from "zod";
import { idSchema, languageSchema, paginationQuerySchema } from "@bam/contracts";
import { locationTypeSchema } from "../locations/location.schemas.js";

/**
 * The public face of the catalogue (tech-impl §16).
 *
 * These schemas are deliberately *not* the staff ones with a filter applied.
 * They are a separate, smaller shape, so that adding a field to the staff API
 * cannot quietly publish it to the internet. Note what is missing from
 * `publicProviderSchema`: a provider's email and phone are staff contact
 * details, not booking-page content.
 */

export const publicLocationSchema = z.object({
  id: idSchema,
  name: z.string(),
  type: locationTypeSchema,
  addressLine1: z.string().nullable(),
  addressLine2: z.string().nullable(),
  city: z.string().nullable(),
  postalCode: z.string().nullable(),
  countryCode: z.string().nullable(),
  timezone: z.string(),
  latitude: z.number().nullable(),
  longitude: z.number().nullable(),
});

export const publicTenantSchema = z.object({
  id: idSchema,
  slug: z.string(),
  name: z.string(),
  defaultTimezone: z.string(),
  defaultLanguage: z.string(),
  /** Every locale this tenant can actually serve: its own, plus any locale a
   *  service has been translated into. */
  languages: z.array(z.string()),
  logoUrl: z.string().nullable(),
  primaryColor: z.string().nullable(),
  contactEmail: z.string().nullable(),
  contactPhone: z.string().nullable(),
  bookingPolicy: z.string().nullable(),
  cancellationPolicy: z.string().nullable(),
  privacyPolicyUrl: z.string().nullable(),
  locations: z.array(publicLocationSchema),
});

export const publicServiceSchema = z.object({
  id: idSchema,
  slug: z.string(),
  /** Already resolved for the requested locale — the caller does not pick. */
  name: z.string(),
  description: z.string().nullable(),
  durationMinutes: z.number().int(),
  priceMinor: z.number().int().nullable(),
  currency: z.string().nullable(),
  requiresApproval: z.boolean(),
});

export const publicProviderSchema = z.object({
  id: idSchema,
  displayName: z.string(),
  description: z.string().nullable(),
  languages: z.array(z.string()),
  timezone: z.string(),
});

export const tenantSlugParamsSchema = z.object({
  tenantSlug: z.string().min(1).max(63),
});

export const publicListQuerySchema = paginationQuerySchema.extend({
  /** Defaults to the tenant's own language. */
  locale: languageSchema.optional(),
});

export const publicServicesQuerySchema = publicListQuerySchema.extend({
  /** Only what this provider offers — step 3 of the booking flow (§30). */
  providerId: idSchema.optional(),
});

export const publicProvidersQuerySchema = publicListQuerySchema.extend({
  /** Only providers who offer this service. */
  serviceId: idSchema.optional(),
});
