import { roleCanReceiveDelegation } from "@bam/auth";
import { AppError, ErrorCodes, NotFoundError } from "@bam/contracts";
import type { DelegationScope, PrismaClient, Provider } from "@bam/db";
import { DelegationRepository, type DelegationWithMember } from "./delegation.repository.js";

/**
 * The named member cannot receive this diary.
 *
 * 422 rather than 403, and its own code rather than `VALIDATION_FAILED`,
 * because the refusal is about the *target* rather than the caller. See
 * `DELEGATION_TARGET_INELIGIBLE` in @bam/contracts.
 */
function targetIneligible(message: string): AppError {
  return new AppError(ErrorCodes.DELEGATION_TARGET_INELIGIBLE, message, { statusCode: 422 });
}

export interface CandidateMember {
  membershipId: string;
  userId: string;
  name: string;
  email: string;
  role: string;
  roleReceivesDelegations: boolean;
  alreadyDelegated: boolean;
}

export interface MyDelegation {
  providerId: string;
  providerName: string;
  providerTimezone: string;
  providerArchived: boolean;
  scopes: DelegationScope[];
}

/**
 * Granting, re-scoping and revoking a diary.
 * docs/phase-3-4-diary-delegation.md §5.
 *
 * Who *may* grant is not decided here — that is `canDelegateProviderDiary` in
 * @bam/auth, asked by the route before anything below runs (rule 8). What this
 * decides is whether the person being named can receive it, which is a
 * different question with a different answer shape.
 */
export class DelegationService {
  readonly repo: DelegationRepository;

  constructor(private readonly prisma: PrismaClient) {
    this.repo = new DelegationRepository(prisma);
  }

  /**
   * The diary must exist *in this tenant*.
   *
   * Archived is deliberately allowed: an archived provider still has an
   * availability screen and still owns bookings the front desk must cancel
   * (rule 11 keeps the row alive for exactly that). The picker simply does not
   * offer archived diaries — §4.3 of the record says so, because it reads as an
   * oversight otherwise.
   */
  private async requireProvider(tenantId: string, providerId: string): Promise<Provider> {
    const provider = await this.prisma.provider.findFirst({
      where: { id: providerId, tenantId },
    });

    if (!provider) {
      throw new NotFoundError("Provider not found.", ErrorCodes.PROVIDER_NOT_FOUND);
    }

    return provider;
  }

  async listForProvider(args: {
    tenantId: string;
    providerId: string;
  }): Promise<DelegationWithMember[]> {
    await this.requireProvider(args.tenantId, args.providerId);
    return this.repo.listForProvider(args);
  }

  /**
   * Who this diary could be handed to.
   *
   * Exists rather than letting the client filter `GET /v1/members` because the
   * eligibility rule would then live in `apps/web` as a role-string comparison
   * — rule 10 broken at the place it matters most (§5.1).
   */
  async listCandidates(args: {
    tenantId: string;
    providerId: string;
  }): Promise<CandidateMember[]> {
    const provider = await this.requireProvider(args.tenantId, args.providerId);

    const [memberships, existing] = await Promise.all([
      this.repo.listActiveMemberships({ tenantId: args.tenantId }),
      this.repo.listForProvider(args),
    ]);

    const delegated = new Set(existing.map((row) => row.membershipId));

    return memberships
      .filter(
        (membership) =>
          // The membership that *is* this diary already holds the `:own`
          // permissions; a grant would add nothing and would later be misread as
          // the source of that access (§2.2).
          membership.providerId !== provider.id &&
          roleCanReceiveDelegation(membership.role),
      )
      .map((membership) => ({
        membershipId: membership.id,
        userId: membership.user.id,
        name: membership.user.name,
        email: membership.user.email,
        role: membership.role,
        roleReceivesDelegations: true,
        alreadyDelegated: delegated.has(membership.id),
      }));
  }

  /**
   * Grant or re-scope.
   *
   * Returns `created` so the route can pick between the two audit actions —
   * "when did this person first get this diary" stays one grep (§5.3).
   */
  async grant(args: {
    tenantId: string;
    providerId: string;
    membershipId: string;
    scopes: DelegationScope[];
    grantedByUserId: string;
  }): Promise<{ delegation: DelegationWithMember; created: boolean; previousScopes: string[] }> {
    const provider = await this.requireProvider(args.tenantId, args.providerId);

    // Tenant-scoped, so a membership id from another tenant is a plain 404 —
    // indistinguishable from one that never existed (rule 5).
    const target = await this.prisma.membership.findFirst({
      where: { id: args.membershipId, tenantId: args.tenantId },
      select: { id: true, role: true, status: true, providerId: true },
    });

    if (!target) {
      throw new NotFoundError("Member not found.");
    }

    if (target.status !== "ACTIVE") {
      throw targetIneligible("Only an active member can be given a diary.");
    }

    if (!roleCanReceiveDelegation(target.role)) {
      throw targetIneligible("That member's role cannot hold a delegated diary.");
    }

    if (target.providerId === provider.id) {
      throw targetIneligible("That member already runs this diary.");
    }

    const before = await this.repo.findOne({
      tenantId: args.tenantId,
      providerId: args.providerId,
      membershipId: args.membershipId,
    });

    const delegation = await this.repo.upsert({
      tenantId: args.tenantId,
      providerId: args.providerId,
      membershipId: args.membershipId,
      // Deduped defensively as well as in the schema: the database CHECK only
      // guards emptiness, and a repeated scope would be stored verbatim.
      scopes: [...new Set(args.scopes)],
      grantedByUserId: args.grantedByUserId,
    });

    return {
      delegation,
      created: before === null,
      previousScopes: before?.scopes ?? [],
    };
  }

  async revoke(args: {
    tenantId: string;
    providerId: string;
    membershipId: string;
  }): Promise<DelegationWithMember> {
    await this.requireProvider(args.tenantId, args.providerId);

    const existing = await this.repo.findOne(args);
    if (!existing) {
      throw new NotFoundError("This member does not hold that diary.");
    }

    await this.repo.remove(args);
    return existing;
  }

  /** Whose diaries the caller runs, in this tenant. */
  async listMine(args: { tenantId: string; membershipId: string }): Promise<MyDelegation[]> {
    const grants = await this.repo.listForMembership(args);
    if (grants.length === 0) return [];

    const providers = await this.prisma.provider.findMany({
      where: { tenantId: args.tenantId, id: { in: grants.map((row) => row.providerId) } },
      select: { id: true, displayName: true, timezone: true, archivedAt: true },
    });

    const byId = new Map(providers.map((provider) => [provider.id, provider]));

    return grants.flatMap((grant) => {
      const provider = byId.get(grant.providerId);
      // A grant whose provider is not in this tenant cannot be rendered and must
      // not be invented. The FK plus the tenant-scoped read make this
      // unreachable; dropping the row rather than throwing keeps one impossible
      // row from breaking the whole screen.
      if (!provider) return [];

      return [
        {
          providerId: provider.id,
          providerName: provider.displayName,
          providerTimezone: provider.timezone,
          providerArchived: provider.archivedAt !== null,
          scopes: grant.scopes,
        },
      ];
    });
  }
}

/** Serialises a grant row for the wire. */
export function toDelegationResponse(row: DelegationWithMember) {
  return {
    providerId: row.providerId,
    scopes: row.scopes,
    grantedAt: row.grantedAt.toISOString(),
    grantedByUserId: row.grantedByUserId,
    member: {
      membershipId: row.membershipId,
      userId: row.membership.user.id,
      name: row.membership.user.name,
      email: row.membership.user.email,
      role: row.membership.role,
      roleReceivesDelegations: roleCanReceiveDelegation(row.membership.role),
    },
  };
}
