import type { Prisma } from "@bam/db";
import { findCrossTenantRoleConflict, type HeldMembership } from "@bam/auth";
import { ConflictError, ErrorCodes } from "@bam/contracts";

/**
 * Refuse a membership that would make somebody an owner in one organization and
 * a provider in another. docs/phase-9-owner-as-provider.md §2.4.
 *
 * Must run inside the transaction that makes the write, and before it. The
 * rule itself is `findCrossTenantRoleConflict` in `@bam/auth`. This is only the
 * part a pure function cannot do: reading what the person already holds, and
 * making sure nobody else changes that while the write is in flight.
 *
 * ## The lock
 *
 * The rule spans memberships in different tenants, which no constraint can
 * see. Two acceptances for the same person in two organizations would each
 * read the other's row as absent and both commit. So the person's `users` row
 * is locked first. Every enforcing write takes the same lock, so writes for
 * one person serialise and writes for different people never contend. It is
 * rule 14's "the database decides", with a row lock as the arbiter because
 * there is no exclusion constraint to hand the decision to.
 *
 * ## The message
 *
 * It is written for the person the rule is about, and it is shown to them at
 * invitation acceptance. A member-manager linking a colleague also sees it,
 * which tells them that colleague owns or works at another organization. That
 * is unavoidable once the rule exists. What §2.4 does avoid is telling an
 * *inviter* about a stranger, by not checking at issue time.
 */
export async function assertRoleCompatibleAcrossTenants(
  tx: Prisma.TransactionClient,
  proposed: HeldMembership & { userId: string },
): Promise<void> {
  await tx.$queryRaw`SELECT 1 FROM users WHERE id = ${proposed.userId} FOR UPDATE`;

  const held = await tx.membership.findMany({
    where: { userId: proposed.userId, tenantId: { not: proposed.tenantId } },
    select: { tenantId: true, role: true, providerId: true },
  });

  const conflict = findCrossTenantRoleConflict(proposed, held);
  if (conflict === null) return;

  throw new ConflictError(
    ErrorCodes.MEMBERSHIP_ROLE_CONFLICT,
    conflict === "OWNER_ELSEWHERE"
      ? "This account owns another organization, and an owner cannot also work as a provider somewhere else. Use a separate account for provider work."
      : "This account works as a provider at another organization, and a provider cannot also own one. Use a separate account to own an organization.",
    { conflict },
  );
}
