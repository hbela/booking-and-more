import { z } from "zod";
import {
  currencySchema,
  idSchema,
  languageSchema,
  paginationQuerySchema,
  slugSchema,
} from "@bam/contracts";
import {
  maximumAdvanceDaysSchema,
  minimumNoticeMinutesSchema,
} from "../providers/provider.schemas.js";

export const serviceTranslationSchema = z.object({
  locale: languageSchema,
  name: z.string().min(1).max(160),
  description: z.string().max(4000).nullable().optional(),
});

export const serviceResponseSchema = z.object({
  id: idSchema,
  name: z.string(),
  slug: z.string(),
  description: z.string().nullable(),
  durationMinutes: z.number().int(),
  bufferBeforeMinutes: z.number().int(),
  bufferAfterMinutes: z.number().int(),
  priceMinor: z.number().int().nullable(),
  currency: z.string().nullable(),
  active: z.boolean(),
  requiresApproval: z.boolean(),
  minimumNoticeMinutes: z.number().int().nullable(),
  maximumAdvanceDays: z.number().int().nullable(),
  translations: z.array(
    z.object({
      locale: z.string(),
      name: z.string(),
      description: z.string().nullable(),
    }),
  ),
  archivedAt: z.iso.datetime({ offset: true }).nullable(),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
});

/**
 * A price is two fields that only make sense together (tech-impl §10.5).
 * Accepting an amount without a currency produces a row nobody can render, so
 * the pair is validated here rather than left to the display layer to guess.
 */
const priceFields = {
  /** Integer minor units: HUF 12 500 is 1250000. Omit for "price on request". */
  priceMinor: z.number().int().min(0).max(100_000_000).optional(),
  currency: currencySchema.optional(),
};

export const createServiceBodySchema = z
  .object({
    name: z.string().min(2).max(160),
    /** Derived from the name when omitted. Appears in public booking URLs. */
    slug: slugSchema.optional(),
    description: z.string().max(4000).optional(),
    durationMinutes: z.number().int().min(5).max(1440),
    bufferBeforeMinutes: z.number().int().min(0).max(240).optional(),
    bufferAfterMinutes: z.number().int().min(0).max(240).optional(),
    ...priceFields,
    active: z.boolean().optional(),
    requiresApproval: z.boolean().optional(),
    minimumNoticeMinutes: minimumNoticeMinutesSchema.optional(),
    maximumAdvanceDays: maximumAdvanceDaysSchema.optional(),
    /** Tenant-managed translations (tech-impl §38). Replaceable later. */
    translations: z.array(serviceTranslationSchema).max(8).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.priceMinor !== undefined && !value.currency) {
      ctx.addIssue({
        code: "custom",
        path: ["currency"],
        message: "A currency is required when a price is set.",
      });
    }
  });

/**
 * `slug` is updatable, unlike a tenant's.
 *
 * The difference is what depends on it: a tenant slug is the root of every
 * booking link a business has ever printed, while a service slug is one path
 * segment inside a flow that addresses services by id. Renaming a service is a
 * routine thing a clinic does; renaming a tenant is not.
 */
export const updateServiceBodySchema = z
  .object({
    name: z.string().min(2).max(160),
    slug: slugSchema,
    description: z.string().max(4000).nullable(),
    durationMinutes: z.number().int().min(5).max(1440),
    bufferBeforeMinutes: z.number().int().min(0).max(240),
    bufferAfterMinutes: z.number().int().min(0).max(240),
    priceMinor: z.number().int().min(0).max(100_000_000).nullable(),
    currency: currencySchema.nullable(),
    active: z.boolean(),
    requiresApproval: z.boolean(),
    minimumNoticeMinutes: minimumNoticeMinutesSchema.nullable(),
    maximumAdvanceDays: maximumAdvanceDaysSchema.nullable(),
  })
  .partial();
// The price/currency pairing is *not* re-checked here. A PATCH that sets only
// `priceMinor` on a service that already stores a currency is perfectly valid,
// and a schema cannot see the stored row — so that rule lives in the service,
// which merges the patch onto the current values first.

export const setServiceTranslationsBodySchema = z.object({
  translations: z.array(serviceTranslationSchema).max(8),
});

export const listServicesQuerySchema = paginationQuerySchema.extend({
  includeArchived: z.stringbool().default(false),
  active: z.stringbool().optional(),
  /** Only services this provider offers. */
  providerId: idSchema.optional(),
});

export type CreateServiceBody = z.infer<typeof createServiceBodySchema>;
export type UpdateServiceBody = z.infer<typeof updateServiceBodySchema>;
export type ServiceTranslationInput = z.infer<typeof serviceTranslationSchema>;
export type ListServicesQuery = z.infer<typeof listServicesQuerySchema>;
