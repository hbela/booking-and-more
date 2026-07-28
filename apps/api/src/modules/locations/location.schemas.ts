import { z } from "zod";
import { idSchema, paginationQuerySchema, timezoneSchema } from "@bam/contracts";

/** tech-impl §10.7. */
export const locationTypeSchema = z.enum(["PHYSICAL", "ONLINE", "HOME_VISIT", "TELEPHONE"]);
export type LocationTypeValue = z.infer<typeof locationTypeSchema>;

/** Types that put the customer somewhere specific, and therefore need one. */
export const ADDRESSED_TYPES: readonly LocationTypeValue[] = ["PHYSICAL"];

export const locationResponseSchema = z.object({
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
  active: z.boolean(),
  archivedAt: z.iso.datetime({ offset: true }).nullable(),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
});

const addressFields = {
  addressLine1: z.string().max(200),
  addressLine2: z.string().max(200),
  city: z.string().max(120),
  postalCode: z.string().max(20),
  /** ISO 3166-1 alpha-2. Upper-cased so "hu" and "HU" are the same country. */
  countryCode: z.string().length(2).toUpperCase(),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
};

export const createLocationBodySchema = z
  .object({
    name: z.string().min(2).max(160),
    type: locationTypeSchema.default("PHYSICAL"),
    /** Omitted means "the tenant's zone" — resolved server-side, never NULL. */
    timezone: timezoneSchema.optional(),
    active: z.boolean().optional(),
    addressLine1: addressFields.addressLine1.optional(),
    addressLine2: addressFields.addressLine2.optional(),
    city: addressFields.city.optional(),
    postalCode: addressFields.postalCode.optional(),
    countryCode: addressFields.countryCode.optional(),
    latitude: addressFields.latitude.optional(),
    longitude: addressFields.longitude.optional(),
  })
  .superRefine((value, ctx) => {
    // A PHYSICAL location with no street is a location nobody can find. The rule
    // lives here rather than in the database because Postgres cannot express
    // "required unless type is ONLINE" without a check constraint per column.
    if (ADDRESSED_TYPES.includes(value.type) && !value.addressLine1) {
      ctx.addIssue({
        code: "custom",
        path: ["addressLine1"],
        message: "A physical location needs a street address.",
      });
    }
  });

/**
 * `type` is updatable, and switching a PHYSICAL location to ONLINE leaves the
 * address in place rather than clearing it — the same room may go back to
 * in-person next month, and silently discarding data the user typed is worse
 * than carrying a field nothing reads.
 */
export const updateLocationBodySchema = z
  .object({
    name: z.string().min(2).max(160),
    type: locationTypeSchema,
    timezone: timezoneSchema,
    active: z.boolean(),
    addressLine1: addressFields.addressLine1.nullable(),
    addressLine2: addressFields.addressLine2.nullable(),
    city: addressFields.city.nullable(),
    postalCode: addressFields.postalCode.nullable(),
    countryCode: addressFields.countryCode.nullable(),
    latitude: addressFields.latitude.nullable(),
    longitude: addressFields.longitude.nullable(),
  })
  .partial();

export const listLocationsQuerySchema = paginationQuerySchema.extend({
  includeArchived: z.stringbool().default(false),
  active: z.stringbool().optional(),
});

export type CreateLocationBody = z.infer<typeof createLocationBodySchema>;
export type UpdateLocationBody = z.infer<typeof updateLocationBodySchema>;
