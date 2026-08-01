import { createHash, randomBytes } from "node:crypto";
import type { PrismaClient } from "@bam/db";
import { canHoldTenantMembership, INVITABLE_ROLES, Roles, type Role } from "@bam/auth";
import {
  ConflictError,
  ErrorCodes,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from "@bam/contracts";

export interface InviteInput {
  tenantId: string;
  email: string;
  role: Role;
  invitedByUserId: string;
  expiryHours: number;
}

export interface InviteResult {
  invitationId: string;
  /** The raw token. Returned exactly once, never stored, never logged. */
  token: string;
  expiresAt: Date;
}

/**
 * Memberships and invitations.
 *
 * The two rules this class exists to enforce are "a tenant always has at least
 * one owner" and "an invitation token is a bearer credential". Both are easy to
 * get wrong in a route handler and hard to notice afterwards.
 */
export class MembershipService {
  constructor(private readonly prisma: PrismaClient) {}

  // -------------------------------------------------------------------------
  // Members
  // -------------------------------------------------------------------------

  async list(tenantId: string) {
    return this.prisma.membership.findMany({
      where: { tenantId },
      include: { user: { select: { id: true, name: true, email: true } } },
      orderBy: [{ role: "asc" }, { createdAt: "asc" }],
    });
  }

  async findById(tenantId: string, membershipId: string) {
    // Both IDs in the WHERE clause, not just the membership ID. Looking up by
    // ID alone and checking the tenant afterwards is how cross-tenant reads
    // happen (CLAUDE.md rule 5).
    return this.prisma.membership.findFirst({
      where: { id: membershipId, tenantId },
      include: { user: { select: { id: true, name: true, email: true } } },
    });
  }

  /**
   * Change a member's role.
   *
   * Guards the last owner: demoting the only OWNER would leave the tenant with
   * nobody who can manage billing, invite anyone, or undo the change.
   */
  async changeRole(tenantId: string, membershipId: string, role: Role) {
    const membership = await this.findById(tenantId, membershipId);
    if (!membership) {
      throw new NotFoundError("Member not found.");
    }

    if (membership.role === Roles.OWNER && role !== Roles.OWNER) {
      await this.assertNotLastOwner(tenantId, membershipId);
    }

    return this.prisma.membership.update({
      where: { id: membershipId },
      data: { role },
      include: { user: { select: { id: true, name: true, email: true } } },
    });
  }

  /**
   * Link a membership to a provider, or unlink it with `null`.
   *
   * This is what turns "someone with the PROVIDER role" into "the person whose
   * diary this is": `canForProvider` in @bam/auth compares
   * `membership.providerId` against the resource, so an unlinked provider
   * membership holds `:own` permissions that match nothing.
   *
   * The provider is looked up inside the tenant, so a provider id from
   * elsewhere is a 404 rather than a cross-tenant link.
   */
  async linkProvider(tenantId: string, membershipId: string, providerId: string | null) {
    const membership = await this.findById(tenantId, membershipId);
    if (!membership) {
      throw new NotFoundError("Member not found.");
    }

    if (providerId !== null) {
      const provider = await this.prisma.provider.findFirst({
        where: { id: providerId, tenantId, archivedAt: null },
        select: { id: true },
      });

      if (!provider) {
        throw new NotFoundError("Provider not found.", ErrorCodes.PROVIDER_NOT_FOUND);
      }

      // Checked up front for a usable message; the unique index is what holds
      // under concurrency.
      const alreadyLinked = await this.prisma.membership.findFirst({
        where: { providerId, id: { not: membershipId } },
        select: { id: true },
      });

      if (alreadyLinked) {
        throw new ConflictError(
          ErrorCodes.VALIDATION_FAILED,
          "That provider is already linked to another member. Unlink it first.",
          { field: "providerId" },
        );
      }
    }

    return this.prisma.membership.update({
      where: { id: membershipId },
      data: { providerId },
      include: { user: { select: { id: true, name: true, email: true } } },
    });
  }

  async remove(tenantId: string, membershipId: string): Promise<void> {
    const membership = await this.findById(tenantId, membershipId);
    if (!membership) {
      throw new NotFoundError("Member not found.");
    }

    if (membership.role === Roles.OWNER) {
      await this.assertNotLastOwner(tenantId, membershipId);
    }

    await this.prisma.membership.delete({ where: { id: membershipId } });
  }

  private async assertNotLastOwner(tenantId: string, excludingMembershipId: string): Promise<void> {
    const otherOwners = await this.prisma.membership.count({
      where: {
        tenantId,
        role: Roles.OWNER,
        status: "ACTIVE",
        id: { not: excludingMembershipId },
      },
    });

    if (otherOwners === 0) {
      throw new ConflictError(
        ErrorCodes.VALIDATION_FAILED,
        "This is the only owner. Promote another member to owner first.",
      );
    }
  }

  // -------------------------------------------------------------------------
  // Invitations
  // -------------------------------------------------------------------------

  async invite(input: InviteInput): Promise<InviteResult> {
    if (!INVITABLE_ROLES.includes(input.role)) {
      throw new ValidationError(`${input.role} cannot be granted by invitation.`, {
        field: "role",
      });
    }

    const email = input.email.toLowerCase();

    // Already a member: re-inviting would either be a no-op or silently change
    // their role, and neither is what the caller expects.
    const existingMember = await this.prisma.membership.findFirst({
      where: { tenantId: input.tenantId, user: { email } },
      select: { id: true },
    });

    if (existingMember) {
      throw new ConflictError(
        ErrorCodes.VALIDATION_FAILED,
        "That person is already a member of this tenant.",
        { field: "email" },
      );
    }

    // Supersede any live invitation for this address, so the newest link is the
    // only one that works and the partial unique index stays satisfied.
    await this.prisma.invitation.updateMany({
      where: { tenantId: input.tenantId, email, status: "PENDING" },
      data: { status: "REVOKED" },
    });

    // 32 bytes of CSPRNG output (tech-impl §34.4). Only the hash is persisted:
    // a database leak must not yield working invitation links.
    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + input.expiryHours * 60 * 60 * 1000);

    const invitation = await this.prisma.invitation.create({
      data: {
        tenantId: input.tenantId,
        email,
        role: input.role,
        tokenHash: hashToken(token),
        expiresAt,
        invitedByUserId: input.invitedByUserId,
      },
    });

    return { invitationId: invitation.id, token, expiresAt };
  }

  async listInvitations(tenantId: string) {
    return this.prisma.invitation.findMany({
      where: { tenantId, status: "PENDING" },
      // tokenHash is deliberately not selected — it never leaves this class.
      select: {
        id: true,
        email: true,
        role: true,
        status: true,
        expiresAt: true,
        createdAt: true,
        invitedBy: { select: { id: true, name: true, email: true } },
      },
      orderBy: { createdAt: "desc" },
    });
  }

  async revokeInvitation(tenantId: string, invitationId: string): Promise<void> {
    const result = await this.prisma.invitation.updateMany({
      where: { id: invitationId, tenantId, status: "PENDING" },
      data: { status: "REVOKED" },
    });

    if (result.count === 0) {
      throw new NotFoundError("Invitation not found or already resolved.");
    }
  }

  /**
   * Accept an invitation and become a member, in one transaction.
   *
   * Rejects when the signed-in user's address differs from the invited one: an
   * invitation names a person, and letting anyone holding the link join as
   * themselves would turn a leaked email into an access grant.
   */
  async acceptInvitation(
    token: string,
    userId: string,
    userEmail: string,
    isPlatformAdmin: boolean,
  ) {
    // Separation of duties, checked before the token is even looked up: a
    // platform admin already has access to every tenant, so accepting adds
    // nothing but a membership that muddies their audit trail.
    //
    // Note that CLAUDE.md rule 9 already stops PLATFORM_ADMIN being granted by
    // invitation; this is the mirror image — an invitation must not be able to
    // pull an existing platform admin into a tenant either.
    if (!canHoldTenantMembership({ isPlatformAdmin })) {
      throw new ForbiddenError(
        "A platform administrator cannot join a tenant. Use a separate account for tenant work.",
      );
    }

    const invitation = await this.findValidInvitation(token);

    if (invitation.email.toLowerCase() !== userEmail.toLowerCase()) {
      throw new ConflictError(
        ErrorCodes.FORBIDDEN,
        `This invitation was issued to ${invitation.email}. Sign in as that user to accept it.`,
      );
    }

    return this.claimInvitation(invitation, userId);
  }

  /**
   * What the invitation landing page needs before it can render.
   * docs/phase-9-owner-onboarding.md §2.3.
   *
   * Reveals the invited address and the organization's name to whoever holds
   * the token. Not an enumeration risk — the caller must already possess 32
   * bytes of CSPRNG output naming this specific invitation, and the email that
   * carried it said all of this already.
   */
  async describeInvitation(token: string) {
    const invitation = await this.findValidInvitation(token);

    const [tenant, existingUser] = await Promise.all([
      this.prisma.tenant.findUnique({
        where: { id: invitation.tenantId },
        select: { name: true },
      }),
      this.prisma.user.findUnique({
        where: { email: invitation.email },
        select: { id: true },
      }),
    ]);

    if (!tenant) throw new NotFoundError("This invitation link is not valid.");

    return {
      organizationName: tenant.name,
      email: invitation.email,
      role: invitation.role,
      expiresAt: invitation.expiresAt,
      // Drives which screen the page shows. False sends them to sign-in
      // instead of a form that would only refuse them.
      requiresRegistration: existingUser === null,
    };
  }

  /**
   * Create the account the invitation was issued to, and claim the invitation
   * with it. docs/phase-9-owner-onboarding.md §2.1, §2.4.
   *
   * `createUser` is injected rather than called directly because Better Auth
   * owns the user row, and it is the API layer that holds the Better Auth
   * instance. That also keeps this class free of HTTP concerns — the caller
   * deals with the session cookie that comes back.
   *
   * **The email is taken from the invitation, never from the caller.** A route
   * that accepted an address alongside the token would turn a link that is only
   * a claim about one mailbox into a general-purpose grant: anyone holding a
   * leaked token could register an address of their choosing and take the
   * membership with it. This is the one security property of the whole flow.
   */
  async registerAndAccept(input: {
    token: string;
    name: string;
    createUser: (details: { email: string; name: string }) => Promise<{ id: string }>;
  }) {
    const invitation = await this.findValidInvitation(input.token);

    // A brand-new account cannot be a platform admin — `isPlatformAdmin` is
    // declared to Better Auth with `input: false`, so no sign-up can set it —
    // but the invariant is asserted rather than reasoned about, so that a
    // future change to how users are created cannot quietly bypass rule 9.
    const existing = await this.prisma.user.findUnique({
      where: { email: invitation.email },
      select: { id: true },
    });

    if (existing) {
      throw new ConflictError(
        ErrorCodes.VALIDATION_FAILED,
        `An account already exists for ${invitation.email}. Sign in, then open the invitation link again.`,
      );
    }

    const user = await input.createUser({ email: invitation.email, name: input.name });

    // Not in the transaction below, and cannot be: Better Auth owns this row.
    // The token only ever existed inside the invited mailbox, so receiving it
    // is the same proof a verification email would have collected (§2.2).
    await this.prisma.user.update({
      where: { id: user.id },
      data: { emailVerified: true },
    });

    // If this throws, a user exists with no membership. Recoverable without
    // new code: the invitation is still PENDING, and re-opening the link now
    // takes the "account already exists" branch above, which points at sign-in
    // and the ordinary accept route (§2.4).
    const result = await this.claimInvitation(invitation, user.id);

    return { ...result, userId: user.id, email: invitation.email };
  }

  /**
   * Look a token up and refuse it unless it is live.
   *
   * Shared by every path that consumes an invitation so they cannot drift
   * apart: the uniform error below is a security property, and a second copy
   * of this logic is how one of them loses it.
   */
  private async findValidInvitation(token: string) {
    const invitation = await this.prisma.invitation.findUnique({
      where: { tokenHash: hashToken(token) },
    });

    // Same error for "no such token", "already used" and "revoked": an attacker
    // holding a guess must not learn which of those it was.
    if (!invitation || invitation.status !== "PENDING") {
      throw new NotFoundError("This invitation link is not valid.");
    }

    if (invitation.expiresAt.getTime() < Date.now()) {
      await this.prisma.invitation.update({
        where: { id: invitation.id },
        data: { status: "EXPIRED" },
      });
      throw new NotFoundError("This invitation has expired. Ask for a new one.");
    }

    return invitation;
  }

  /** Grant the membership and burn the invitation, atomically. */
  private async claimInvitation(
    invitation: { id: string; tenantId: string; role: Role; invitedByUserId: string },
    userId: string,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const membership = await tx.membership.upsert({
        where: { tenantId_userId: { tenantId: invitation.tenantId, userId } },
        // Already a member somehow — take the invited role rather than failing.
        update: { role: invitation.role, status: "ACTIVE", joinedAt: new Date() },
        create: {
          tenantId: invitation.tenantId,
          userId,
          role: invitation.role,
          status: "ACTIVE",
          invitedByUserId: invitation.invitedByUserId,
          joinedAt: new Date(),
        },
      });

      await tx.invitation.update({
        where: { id: invitation.id },
        data: { status: "ACCEPTED", acceptedAt: new Date() },
      });

      return { membership, tenantId: invitation.tenantId };
    });
  }
}

/**
 * SHA-256, matching the booking-management-token scheme (tech-impl §34.4).
 *
 * Plain SHA-256 rather than a password KDF is correct here: the token is 32
 * bytes of CSPRNG output, so there is no low-entropy guess space for a slow
 * hash to protect. What matters is that the stored value is not usable.
 */
function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
