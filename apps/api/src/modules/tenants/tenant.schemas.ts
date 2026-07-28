import { z } from "zod";
import { SLUG_PATTERN, idSchema, languageSchema, timezoneSchema } from "@bam/contracts";

/**
 * Tenant slugs become public URLs (booking.example.com/<slug>), so the rules are
 * strict: lowercase, no leading or trailing hyphen, no doubled hyphens. The
 * character rules are shared with every other public slug; only the length
 * bounds are specific to tenants.
 */
export const tenantSlugSchema = z
  .string()
  .min(3)
  .max(63)
  .regex(
    SLUG_PATTERN,
    "must be lowercase letters, digits and single hyphens, e.g. sunshine-dental",
  );

/**
 * Slugs that must not be claimed by a tenant, because they collide with
 * platform routes or invite phishing.
 */
export const RESERVED_SLUGS: readonly string[] = [
  "api",
  "admin",
  "app",
  "auth",
  "booking",
  "bookings",
  "dashboard",
  "docs",
  "health",
  "login",
  "logout",
  "platform",
  "settings",
  "signin",
  "signup",
  "support",
  "www",
];

export const tenantStatusSchema = z.enum(["TRIAL", "ACTIVE", "SUSPENDED", "CLOSED"]);

export const createTenantBodySchema = z.object({
  name: z.string().min(2).max(120),
  slug: tenantSlugSchema,
  defaultTimezone: timezoneSchema.default("Europe/Budapest"),
  defaultLanguage: languageSchema.default("hu"),
  contactEmail: z.email().optional(),
  contactPhone: z.string().max(40).optional(),
});

/**
 * `slug` is absent on purpose. It is published in booking URLs, QR codes and
 * emails; renaming it silently breaks every link already in the wild. A rename
 * needs a redirect story, which is Epic 9's problem.
 *
 * `status` is absent too: tenant lifecycle is a platform-admin operation, not
 * something an owner can set on themselves.
 */
export const updateTenantBodySchema = z
  .object({
    name: z.string().min(2).max(120),
    defaultTimezone: timezoneSchema,
    defaultLanguage: languageSchema,
    contactEmail: z.email().nullable(),
    contactPhone: z.string().max(40).nullable(),
    logoUrl: z.url().nullable(),
    primaryColor: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/, "must be a hex colour such as #0f766e")
      .nullable(),
    bookingPolicy: z.string().max(4000).nullable(),
    cancellationPolicy: z.string().max(4000).nullable(),
    privacyPolicyUrl: z.url().nullable(),
  })
  .partial();

export const tenantResponseSchema = z.object({
  id: idSchema,
  slug: z.string(),
  name: z.string(),
  status: tenantStatusSchema,
  defaultTimezone: z.string(),
  defaultLanguage: z.string(),
  logoUrl: z.string().nullable(),
  primaryColor: z.string().nullable(),
  contactEmail: z.string().nullable(),
  contactPhone: z.string().nullable(),
  bookingPolicy: z.string().nullable(),
  cancellationPolicy: z.string().nullable(),
  privacyPolicyUrl: z.string().nullable(),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
});

export type CreateTenantBody = z.infer<typeof createTenantBodySchema>;
export type UpdateTenantBody = z.infer<typeof updateTenantBodySchema>;
export type TenantResponse = z.infer<typeof tenantResponseSchema>;
