import { z } from "zod";
import { domainSchema, idSchema, SLUG_MESSAGE, SLUG_PATTERN } from "@bam/contracts";

import { RESERVED_SLUGS } from "../tenants/tenant.schemas.js";

/**
 * Platform-administration schemas. docs/phase-9-saas-administration.md §4.
 *
 * Separate from `tenant.schemas.ts` for the same reason the public catalogue
 * has its own (CLAUDE.md rule 12): what a platform operator may see and set is
 * a different question from what a tenant's own staff may, and answering both
 * from one schema means a field added for one silently appears in the other.
 */

export const provisioningModes = ["PROSPECT", "INTERNAL"] as const;

export const provisionOrganizationBodySchema = z.object({
  name: z.string().min(1).max(120),

  slug: z
    .string()
    .min(2)
    .max(63)
    .regex(SLUG_PATTERN, SLUG_MESSAGE)
    .refine((value) => !RESERVED_SLUGS.includes(value), {
      message: "That slug is reserved. Please choose another.",
    }),

  /**
   * The business's own domain — the organization's identity (§2.3). Required,
   * unlike the predecessor's nullable column, because a guarantee that holds
   * only for rows somebody remembered to fill in is not a guarantee.
   */
  domain: domainSchema,

  ownerName: z.string().min(1).max(120),
  ownerEmail: z.email().max(254),

  /**
   * PROSPECT is gated and expires; INTERNAL is active immediately and never
   * expires (§2.2). Defaulted to PROSPECT because that is the paying case, and
   * a mistyped mode should fail closed rather than mint a free organization.
   */
  mode: z.enum(provisioningModes).default("PROSPECT"),

  defaultTimezone: z.string().min(1).max(64).default("Europe/Budapest"),
  defaultLanguage: z.enum(["hu", "en"]).default("hu"),
});

export type ProvisionOrganizationBody = z.infer<typeof provisionOrganizationBodySchema>;

export const organizationStatusSchema = z.enum([
  "PENDING_SUBSCRIPTION",
  "TRIAL",
  "ACTIVE",
  "SUSPENDED",
  "CLOSED",
]);

/**
 * What the platform dashboard shows per organization.
 *
 * Note what is absent: nothing about the tenant's customers, bookings or
 * providers. A platform operator manages accounts, not the data inside them,
 * and the response type is where that boundary is easiest to keep.
 */
export const organizationSummarySchema = z.object({
  id: idSchema,
  name: z.string(),
  slug: z.string(),
  domain: z.string().nullable(),
  status: organizationStatusSchema,
  subscribeBy: z.iso.datetime().nullable(),
  /** Null when there is no deadline — an internal organization, or one that subscribed. */
  daysRemaining: z.number().int().nullable(),
  createdAt: z.iso.datetime(),

  owner: z
    .object({
      email: z.email(),
      name: z.string().nullable(),
      /** False while the owner has not yet accepted their invitation. */
      accepted: z.boolean(),
    })
    .nullable(),

  subscription: z
    .object({
      plan: z.enum(["INTERNAL", "STARTER", "PROFESSIONAL"]),
      status: z.enum([
        "ACTIVE",
        "PAST_DUE",
        "CANCELED",
        "INCOMPLETE",
        "TRIALING",
        "NOT_APPLICABLE",
      ]),
      currentPeriodEnd: z.iso.datetime().nullable(),
      cancelAtPeriodEnd: z.boolean(),
    })
    .nullable(),
});

export type OrganizationSummary = z.infer<typeof organizationSummarySchema>;

export const listOrganizationsQuerySchema = z.object({
  status: organizationStatusSchema.optional(),
  /** Matches name, slug or domain. */
  search: z.string().min(1).max(120).optional(),
});

export const organizationListResponseSchema = z.object({
  items: z.array(organizationSummarySchema),
});

export const provisionOrganizationResponseSchema = z.object({
  organization: organizationSummarySchema,
  /**
   * The owner's acceptance link, returned **once** and never stored — only its
   * SHA-256 hash is (tech-impl §34.4). Present so the operator can hand it over
   * directly if email delivery is not yet configured; Epic 5 sends it.
   */
  acceptUrl: z.url(),
});

export const organizationIdParamsSchema = z.object({ id: idSchema });

export const setStatusBodySchema = z.object({
  /**
   * CLOSED is deliberately absent from what suspend/reactivate can set: closing
   * an organization is a separate, heavier action with its own route, and
   * folding it into a status setter makes it one typo away from every
   * suspension (§2.6).
   *
   * `ACTIVE` reads as *restore access* rather than a literal target. What the
   * organization actually becomes is derived from its subscription — a
   * trialling one returns to TRIAL, one with no live subscription to
   * PENDING_SUBSCRIPTION. The response carries the status it reached.
   */
  status: z.enum(["ACTIVE", "SUSPENDED"]),
});
