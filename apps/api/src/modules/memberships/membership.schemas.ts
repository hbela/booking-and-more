import { z } from "zod";
import { idSchema } from "@bam/contracts";

/**
 * Membership and invitation schemas. tech-impl §6.
 *
 * Lifted out of `membership.routes.ts` so `membership.test.ts` can assert what
 * the comment below has always claimed: that these literals stay in step with
 * `@bam/auth`'s role table.
 */

export const roleSchema = z.enum(["OWNER", "ADMIN", "PROVIDER", "ASSISTANT", "CUSTOMER"]);

/**
 * Roles grantable by invitation. Spelled out rather than derived from
 * INVITABLE_ROLES so Zod infers a literal union instead of `string` — the
 * derived version type-checked but let any string through the handler types.
 * Kept in step with @bam/auth by the test in membership.test.ts.
 */
export const invitableRoleSchema = z.enum(["OWNER", "ADMIN", "PROVIDER", "ASSISTANT"]);

export const memberResponseSchema = z.object({
  id: idSchema,
  role: roleSchema,
  status: z.enum(["INVITED", "ACTIVE", "SUSPENDED"]),
  providerId: z.string().nullable(),
  joinedAt: z.iso.datetime({ offset: true }).nullable(),
  createdAt: z.iso.datetime({ offset: true }),
  user: z.object({ id: idSchema, name: z.string(), email: z.email() }),
});

export const invitationResponseSchema = z.object({
  id: idSchema,
  email: z.email(),
  role: roleSchema,
  /**
   * The diary this invitation will link its membership to, if any. Without it
   * a bare PROVIDER invitation gives no hint which provider it is for, and the
   * Providers screen cannot tell whose Invite button should read "Resend".
   */
  providerId: z.string().nullable(),
  status: z.enum(["PENDING", "ACCEPTED", "REVOKED", "EXPIRED"]),
  expiresAt: z.iso.datetime({ offset: true }),
  createdAt: z.iso.datetime({ offset: true }),
  invitedBy: z.object({ id: idSchema, name: z.string(), email: z.email() }),
});
