import type { DelegationScope, Membership, PrismaClient, ProviderDelegation, User } from "@bam/db";

/** A grant with enough of the recipient to render a row. */
export type DelegationWithMember = ProviderDelegation & {
  membership: Membership & { user: Pick<User, "id" | "name" | "email"> };
};

/**
 * Data access for diary delegations. docs/phase-3-4-diary-delegation.md §3.
 *
 * `tenantId` is a required parameter on every method and part of every `where`
 * (rule 5). That is doing more work here than usual: no composite
 * `(tenant_id, provider_id)` foreign key exists — §2.5 records why it was
 * rejected — so the tenant predicate on these reads is what makes a row that
 * somehow named another tenant's diary invisible rather than dangerous.
 */
export class DelegationRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /** Every grant on one diary, for the provider's Delegates panel. */
  async listForProvider(args: {
    tenantId: string;
    providerId: string;
  }): Promise<DelegationWithMember[]> {
    return this.prisma.providerDelegation.findMany({
      where: { tenantId: args.tenantId, providerId: args.providerId },
      include: { membership: { include: { user: { select: { id: true, name: true, email: true } } } } },
      orderBy: [{ grantedAt: "asc" }, { id: "asc" }],
    });
  }

  /** Every grant held by one membership — "whose diaries do I run". */
  async listForMembership(args: {
    tenantId: string;
    membershipId: string;
  }): Promise<ProviderDelegation[]> {
    return this.prisma.providerDelegation.findMany({
      where: { tenantId: args.tenantId, membershipId: args.membershipId },
      orderBy: [{ grantedAt: "asc" }, { id: "asc" }],
    });
  }

  async findOne(args: {
    tenantId: string;
    providerId: string;
    membershipId: string;
  }): Promise<DelegationWithMember | null> {
    return this.prisma.providerDelegation.findFirst({
      where: {
        tenantId: args.tenantId,
        providerId: args.providerId,
        membershipId: args.membershipId,
      },
      include: { membership: { include: { user: { select: { id: true, name: true, email: true } } } } },
    });
  }

  /**
   * Grant or re-scope, in one statement.
   *
   * The unique key is `(providerId, membershipId)`, so re-granting re-scopes the
   * row it finds rather than adding a second one: "what may this person do to
   * this diary" has exactly one answer (§2.6). The caller has already proved
   * both ids belong to `tenantId`.
   */
  async upsert(args: {
    tenantId: string;
    providerId: string;
    membershipId: string;
    scopes: DelegationScope[];
    grantedByUserId: string | null;
  }): Promise<DelegationWithMember> {
    return this.prisma.providerDelegation.upsert({
      where: {
        providerId_membershipId: {
          providerId: args.providerId,
          membershipId: args.membershipId,
        },
      },
      // `grantedByUserId` and `grantedAt` are not touched on update: they record
      // who first handed this diary over, which is the question the audit trail
      // and the panel both want. A re-scope is recorded as its own audit row.
      update: { scopes: args.scopes },
      create: {
        tenantId: args.tenantId,
        providerId: args.providerId,
        membershipId: args.membershipId,
        scopes: args.scopes,
        grantedByUserId: args.grantedByUserId,
      },
      include: { membership: { include: { user: { select: { id: true, name: true, email: true } } } } },
    });
  }

  /** Hard delete (§2.7). Returns how many rows went, so the route can 404. */
  async remove(args: {
    tenantId: string;
    providerId: string;
    membershipId: string;
  }): Promise<number> {
    const { count } = await this.prisma.providerDelegation.deleteMany({
      where: {
        tenantId: args.tenantId,
        providerId: args.providerId,
        membershipId: args.membershipId,
      },
    });

    return count;
  }

  /**
   * Memberships that could receive this diary, with whether they already have it.
   *
   * Returns every ACTIVE membership in the tenant; the service filters by role,
   * because "which roles may receive a delegation" is a permission question and
   * belongs in @bam/auth rather than in a `where` clause (rule 10).
   */
  async listActiveMemberships(args: { tenantId: string }): Promise<
    (Membership & { user: Pick<User, "id" | "name" | "email"> })[]
  > {
    return this.prisma.membership.findMany({
      where: { tenantId: args.tenantId, status: "ACTIVE" },
      include: { user: { select: { id: true, name: true, email: true } } },
      orderBy: [{ role: "asc" }, { createdAt: "asc" }],
    });
  }
}
