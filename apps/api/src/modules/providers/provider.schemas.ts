import { z } from "zod";
import { idSchema, languageSchema, paginationQuerySchema, timezoneSchema } from "@bam/contracts";

/**
 * Booking-window fields, shared by Provider and Service.
 *
 * Nullable rather than defaulted: NULL means "inherit", and the availability
 * engine takes the most restrictive value that applies (tech-impl §13.3). Zero
 * is a real value meaning "bookable up to the last second", so it must be
 * distinguishable from "not set".
 */
export const minimumNoticeMinutesSchema = z.number().int().min(0).max(43_200); // 30 days
export const maximumAdvanceDaysSchema = z.number().int().min(1).max(730); // 2 years

export const providerResponseSchema = z.object({
  id: idSchema,
  displayName: z.string(),
  description: z.string().nullable(),
  /**
   * Nullable on the way out although both write schemas require it: the column
   * is still `String?`, so a provider created before it became mandatory reads
   * back as null. Narrowing this would 500 on exactly those rows.
   */
  email: z.string().nullable(),
  phone: z.string().nullable(),
  timezone: z.string(),
  languages: z.array(z.string()),
  active: z.boolean(),
  onlineBookingEnabled: z.boolean(),
  minimumNoticeMinutes: z.number().int().nullable(),
  maximumAdvanceDays: z.number().int().nullable(),
  archivedAt: z.iso.datetime({ offset: true }).nullable(),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
});

export const createProviderBodySchema = z.object({
  displayName: z.string().min(2).max(160),
  description: z.string().max(4000).optional(),
  /**
   * Required, and not nullable on update either.
   *
   * A provider is a diary, not a login (`Membership.providerId` is what links
   * the two), so this address does not sign anybody in. It is how the person
   * behind the diary is reachable at all — the invitation that would give them a
   * login is addressed to it, and so is every notification about their own
   * bookings. A provider with no address is a diary nobody can be told about.
   */
  email: z.email(),
  phone: z.string().max(40).optional(),
  /** Omitted means "the tenant's zone" — resolved server-side, never left NULL. */
  timezone: timezoneSchema.optional(),
  languages: z.array(languageSchema).max(8).optional(),
  active: z.boolean().optional(),
  onlineBookingEnabled: z.boolean().optional(),
  minimumNoticeMinutes: minimumNoticeMinutesSchema.optional(),
  maximumAdvanceDays: maximumAdvanceDaysSchema.optional(),
});

/**
 * PATCH semantics: an absent key means "leave alone", an explicit `null` means
 * "clear it". `archivedAt` is not here — archiving goes through DELETE, so that
 * it is one auditable action rather than a field anyone can toggle.
 */
export const updateProviderBodySchema = z
  .object({
    displayName: z.string().min(2).max(160),
    description: z.string().max(4000).nullable(),
    /** Not nullable: see the create schema. It may be corrected, never cleared. */
    email: z.email(),
    phone: z.string().max(40).nullable(),
    timezone: timezoneSchema,
    languages: z.array(languageSchema).max(8),
    active: z.boolean(),
    onlineBookingEnabled: z.boolean(),
    minimumNoticeMinutes: minimumNoticeMinutesSchema.nullable(),
    maximumAdvanceDays: maximumAdvanceDaysSchema.nullable(),
  })
  .partial();

export const listProvidersQuerySchema = paginationQuerySchema.extend({
  /** Archived providers are excluded unless asked for — they exist for history. */
  includeArchived: z.stringbool().default(false),
  /** Filter by the active flag. Absent means both. */
  active: z.stringbool().optional(),
});

// --- Assignments -----------------------------------------------------------

export const providerServiceSchema = z.object({
  serviceId: idSchema,
  /** NULL/absent means "use the service's own duration". */
  customDurationMinutes: z.number().int().min(5).max(1440).nullable().optional(),
  customPriceMinor: z.number().int().min(0).nullable().optional(),
  active: z.boolean().default(true),
});

/**
 * A whole-set replacement rather than add/remove calls.
 *
 * The dashboard edits this as a checkbox list, so "here is the complete set"
 * matches what the user did, is idempotent under a double submit, and cannot
 * leave a half-applied change if the browser drops the connection mid-edit.
 */
export const setProviderServicesBodySchema = z.object({
  services: z.array(providerServiceSchema).max(200),
});

export const providerServiceResponseSchema = z.object({
  serviceId: idSchema,
  serviceName: z.string(),
  serviceSlug: z.string(),
  serviceActive: z.boolean(),
  durationMinutes: z.number().int(),
  customDurationMinutes: z.number().int().nullable(),
  customPriceMinor: z.number().int().nullable(),
  active: z.boolean(),
});

export const setProviderLocationsBodySchema = z.object({
  locations: z
    .array(
      z.object({
        locationId: idSchema,
        active: z.boolean().default(true),
      }),
    )
    .max(100),
});

export const providerLocationResponseSchema = z.object({
  locationId: idSchema,
  locationName: z.string(),
  locationType: z.enum(["PHYSICAL", "ONLINE", "HOME_VISIT", "TELEPHONE"]),
  locationActive: z.boolean(),
  active: z.boolean(),
});

export type CreateProviderBody = z.infer<typeof createProviderBodySchema>;
export type UpdateProviderBody = z.infer<typeof updateProviderBodySchema>;
export type ListProvidersQuery = z.infer<typeof listProvidersQuerySchema>;
export type ProviderServiceInput = z.infer<typeof providerServiceSchema>;
export type ProviderResponse = z.infer<typeof providerResponseSchema>;
