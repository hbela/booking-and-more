import { z } from "zod";
import { idSchema } from "@bam/contracts";

/**
 * Request and response shapes for diary delegation.
 * docs/phase-3-4-diary-delegation.md §5.1.
 *
 * The scope union is hand-written rather than derived from `@bam/auth`, exactly
 * as `roleSchema` is in membership.schemas.ts and for the same reason: a Zod
 * literal union is what the OpenAPI spec needs, and generating one from a
 * runtime array loses the literal types. Kept honest by a parity assertion in
 * delegation.schemas.test.ts, which fails the moment the two disagree.
 */
export const delegationScopeSchema = z.enum(["AVAILABILITY", "BOOKINGS"]);

export const delegationScopesSchema = z
  .array(delegationScopeSchema)
  .min(1, "A delegation must cover at least one thing.")
  .max(2)
  // Mirrors the database CHECK plus the unique-per-scope intent: the set is a
  // set, and `["BOOKINGS", "BOOKINGS"]` is a client bug rather than a request.
  .refine((scopes) => new Set(scopes).size === scopes.length, {
    message: "Scopes must not repeat.",
  });

/** The recipient, as much of them as a Delegates row needs. */
export const delegationMemberSchema = z.object({
  membershipId: idSchema,
  userId: idSchema,
  name: z.string(),
  email: z.string(),
  role: z.string(),
  /**
   * False when the member's role no longer holds any `:delegated` permission —
   * the grant survives a role change and confers nothing (§2.8). Surfaced so
   * the state is visible on the screen where it can be fixed, rather than
   * discovered as an access mystery.
   */
  roleReceivesDelegations: z.boolean(),
});

export const delegationResponseSchema = z.object({
  providerId: idSchema,
  scopes: z.array(delegationScopeSchema),
  grantedAt: z.iso.datetime({ offset: true }),
  grantedByUserId: idSchema.nullable(),
  member: delegationMemberSchema,
});

export const setDelegationBodySchema = z.object({
  scopes: delegationScopesSchema,
});

export const delegationCandidateSchema = delegationMemberSchema.extend({
  alreadyDelegated: z.boolean(),
});

/** One row of "whose diaries do I run", for the delegate's own screens. */
export const myDelegationSchema = z.object({
  providerId: idSchema,
  providerName: z.string(),
  providerTimezone: z.string(),
  /** An archived diary keeps its grant (§2.8), so the screen has to say so. */
  providerArchived: z.boolean(),
  scopes: z.array(delegationScopeSchema),
});

export const inviteDelegateBodySchema = z.object({
  /**
   * Typed by the owner. Unlike a provider invitation — where the address comes
   * from the provider record and nowhere else, so a caller cannot attach an
   * arbitrary mailbox to a named diary — there is no record to read here. That
   * is what makes this an invitation rather than a grant, and the authorization
   * that covers it is `delegation:manage`, which only an owner holds.
   */
  email: z.email(),
  scopes: delegationScopesSchema,
});

export const inviteDelegateResponseSchema = z.object({
  id: idSchema,
  email: z.email(),
  providerId: idSchema,
  scopes: z.array(delegationScopeSchema),
  expiresAt: z.iso.datetime({ offset: true }),
  /**
   * Shown once, and still returned even though an email is sent: the worker
   * memoises its email provider at boot, and one that cannot deliver writes
   * SKIPPED rather than a fake SENT (phase-9-owner-onboarding-emails §2).
   * Without this an owner in that state has no recovery path at all.
   */
  acceptUrl: z.url(),
});
