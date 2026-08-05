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
 * Everything {@link MembershipService.inviteProvider} needs about the diary.
 *
 * A structural type rather than Prisma's `Provider`: the route has already
 * resolved the row through `ProviderRepository.findByIdOrThrow`, which carries
 * the `tenantId` rule 5 requires, and this method has no business re-reading it.
 */
export interface InviteProviderInput {
  tenantId: string;
  provider: { id: string; displayName: string; email: string | null; archivedAt: Date | null };
  invitedByUserId: string;
  /** Credited in the email. Null falls back to the organization's name. */
  invitedByName: string | null;
  expiryHours: number;
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

    // PROVIDER *is* invitable — but not from here.
    //
    // This route has no diary to attach, so accepting produced a membership with
    // `providerId` null: `availability:manage:own`, `booking:read:own` and
    // `booking:manage:own`, every one of them matching nothing, and no error
    // anywhere. The person has joined and can do nothing. That is precisely the
    // defect docs/phase-9-provider-onboarding.md exists to remove, and leaving
    // this path open left a second, worse way to reach it — on the landing tab,
    // which is where somebody looking for "invite" looks first.
    //
    // Refused in the service rather than by narrowing INVITABLE_ROLES, because
    // that constant is still telling the truth: the role is grantable by
    // invitation, just by the route that knows which diary is meant.
    if (input.role === Roles.PROVIDER) {
      throw new ValidationError(
        "Invite a provider from their row on the Providers screen, so the invitation carries their diary. Invited from here it would grant a role over no schedule, which can do nothing.",
        { field: "role" },
      );
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

    // 32 bytes of CSPRNG output (tech-impl §34.4). Only the hash is persisted:
    // a database leak must not yield working invitation links.
    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + input.expiryHours * 60 * 60 * 1000);

    // One transaction, so the supersede and the replacement stand or fall
    // together. Revoking first and creating afterwards — which is what this did
    // until phase-9-provider-onboarding §3.1 — leaves the invitee's working link
    // dead with no replacement if the create fails, and tells nobody.
    const invitation = await this.prisma.$transaction(async (tx) => {
      // Supersede any live invitation for this address, so the newest link is
      // the only one that works and the partial unique index stays satisfied.
      await tx.invitation.updateMany({
        where: { tenantId: input.tenantId, email, status: "PENDING" },
        data: { status: "REVOKED" },
      });

      return tx.invitation.create({
        data: {
          tenantId: input.tenantId,
          email,
          role: input.role,
          tokenHash: hashToken(token),
          expiresAt,
          invitedByUserId: input.invitedByUserId,
        },
      });
    });

    return { invitationId: invitation.id, token, expiresAt };
  }

  /**
   * Invite the person behind a provider diary to set up their own login.
   * docs/phase-9-provider-onboarding.md §2.
   *
   * A named method rather than an optional `providerId` on {@link invite}:
   * `invite` is `POST /v1/members/invitations`'s contract, and an optional diary
   * parameter there would be a second, undocumented way to reach this feature
   * that no screen uses and no test covers.
   *
   * What is here and not in `ProviderService`: the token, the hash, the
   * supersede, the outbox event and the transaction that ties them together.
   * Duplicating any of it is exactly how `findValidInvitation`'s own comment
   * says these things drift apart.
   *
   * **The address comes from the provider record and nowhere else.** A caller
   * that could supply one alongside a provider id would be able to attach an
   * arbitrary mailbox to a named diary — phase-9-owner-onboarding §2.1's
   * security property, moved one layer up to issuance (§2.4).
   */
  async inviteProvider(input: InviteProviderInput): Promise<InviteResult & { email: string }> {
    const { tenantId, provider } = input;

    // Belt and braces: the route resolves the provider without
    // `includeArchived`, so an archived one is already a 404 there. Restated
    // because this method writes the row, and a promise to a diary nobody can
    // book is worth refusing wherever it can be refused.
    if (provider.archivedAt !== null) {
      throw new ConflictError(
        ErrorCodes.VALIDATION_FAILED,
        "That provider is archived. Restore them before inviting them.",
      );
    }

    const email = provider.email?.trim().toLowerCase();

    if (email === undefined || email === "") {
      // Legacy rows only: both write schemas have required an address since
      // phase-2-3 §2.8, but the column is still nullable (that record's §5.10).
      throw new ValidationError(
        "This provider has no email address. Add one to their record first.",
        { field: "email" },
      );
    }

    // Both pre-checks exist for the message, not the guarantee — the unique
    // indexes are what hold under concurrency (rule 14). They are separate
    // because each one has a different fix.
    const holder = await this.prisma.membership.findFirst({
      where: { providerId: provider.id },
      select: { id: true, user: { select: { email: true } } },
    });

    if (holder) {
      throw new ConflictError(
        ErrorCodes.VALIDATION_FAILED,
        holder.user.email.toLowerCase() === email
          ? "That provider already has a login."
          : "Another member already holds this provider's diary. Unlink them first.",
        { field: "providerId" },
      );
    }

    const existingMember = await this.prisma.membership.findFirst({
      where: { tenantId, user: { email } },
      select: { id: true },
    });

    if (existingMember) {
      // In the organization already, just not linked to this diary. Point at
      // the fix rather than restating the obstacle.
      throw new ConflictError(
        ErrorCodes.VALIDATION_FAILED,
        `${email} is already a member of this organization. Link their membership to this provider instead.`,
        { field: "email" },
      );
    }

    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + input.expiryHours * 60 * 60 * 1000);

    try {
      const invitation = await this.prisma.$transaction(async (tx) => {
        // Superseded, not refused: pressing Invite a second time means "they
        // never got it" — every time (§2.5).
        //
        // Matched on the address *or* the diary, and both are needed. Correct a
        // provider's email and re-invite, and the new address is free while the
        // old address's live invitation still points at this diary — which
        // invitations_provider_pending_key would then refuse, for a reason that
        // appears nowhere on screen.
        await tx.invitation.updateMany({
          where: {
            tenantId,
            status: "PENDING",
            OR: [{ email }, { providerId: provider.id }],
          },
          data: { status: "REVOKED" },
        });

        const created = await tx.invitation.create({
          data: {
            tenantId,
            email,
            role: Roles.PROVIDER,
            providerId: provider.id,
            tokenHash: hashToken(token),
            expiresAt,
            invitedByUserId: input.invitedByUserId,
          },
        });

        await tx.outboxEvent.create({
          data: {
            tenantId,
            eventType: "PROVIDER_INVITED",
            // The provider, not the tenant. The worker's Tenant handlers read
            // `aggregateId` for the tenant and this one must not — see the
            // comment in `dispatchProviderEvent`.
            aggregateType: "Provider",
            aggregateId: provider.id,
            // The raw token, because this is the only moment it exists: only
            // the SHA-256 hash is stored (tech-impl §34.4), so the worker could
            // not rebuild the link later. Exposure is bounded the way
            // provisioning bounds it — `markProcessed` clears this payload on
            // dispatch, and the sender clears the notification's on SENT.
            payload: {
              email,
              providerName: provider.displayName,
              // Read now rather than joined later: the person who pressed the
              // button is who the email should credit, even if they leave next
              // week. Their address is deliberately absent — the copy needs a
              // name, and rule 6 says not to carry what is not needed.
              invitedByName: input.invitedByName,
              invitationToken: token,
              expiresAt: expiresAt.toISOString(),
            },
          },
        });

        return created;
      });

      return { invitationId: invitation.id, token, expiresAt, email };
    } catch (error) {
      if (isUniqueViolation(error)) {
        // Lost a race with a concurrent invite. Either partial index lands
        // here, and the message covers both because from the owner's side they
        // are one fact: somebody just did this.
        throw new ConflictError(
          ErrorCodes.VALIDATION_FAILED,
          "An invitation for this provider was just created. Refresh and check before sending another.",
        );
      }

      throw error;
    }
  }

  async listInvitations(tenantId: string) {
    return this.prisma.invitation.findMany({
      where: { tenantId, status: "PENDING" },
      // tokenHash is deliberately not selected — it never leaves this class.
      select: {
        id: true,
        email: true,
        role: true,
        providerId: true,
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

    // Scoped by tenant even though the foreign key guarantees it — rule 5 is
    // not conditional on the read being provably safe.
    //
    // Revealing the diary's name costs nothing that was not already spent: the
    // lookup hands the organization and the invited address to whoever holds
    // the token, and the email that carried it named the provider in its
    // greeting. What it buys is that "Join X as Dr. Kovács Anna" is how an
    // invitee notices the clinic sent them the wrong person's link *before*
    // accepting, which is not something they can undo afterwards.
    const provider =
      invitation.providerId === null
        ? null
        : await this.prisma.provider.findFirst({
            where: { id: invitation.providerId, tenantId: invitation.tenantId },
            select: { displayName: true },
          });

    return {
      organizationName: tenant.name,
      email: invitation.email,
      role: invitation.role,
      providerName: provider?.displayName ?? null,
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

  /**
   * Grant the membership and burn the invitation, atomically.
   *
   * ## The provider link is made in here, and that placement is load-bearing
   *
   * docs/phase-9-provider-onboarding.md §2.7. Two properties fall out of it, and
   * both are easy to lose in a refactor that tidies the transaction boundary.
   *
   * **The provider is re-read inside the transaction.** Between the email being
   * sent and the link being clicked, the diary may have been archived. Linking
   * to an archived provider produces a member with `:own` permissions over a row
   * every query excludes — a role that does nothing, with no error anywhere.
   *
   * **The invitation stays PENDING when the diary was taken first.** The
   * `status: ACCEPTED` write rolls back with everything else, so an owner who
   * unlinks the other member makes the existing link work again with no
   * reissue. The invitee did nothing wrong and should not need a new token.
   */
  private async claimInvitation(
    invitation: {
      id: string;
      tenantId: string;
      role: Role;
      invitedByUserId: string;
      providerId: string | null;
    },
    userId: string,
  ) {
    try {
      return await this.prisma.$transaction(async (tx) => {
        if (invitation.providerId !== null) {
          const provider = await tx.provider.findFirst({
            where: { id: invitation.providerId, tenantId: invitation.tenantId, archivedAt: null },
            select: { id: true },
          });

          if (!provider) {
            throw new ConflictError(
              ErrorCodes.PROVIDER_NOT_FOUND,
              "The provider this invitation was for is no longer active. Ask the organization to invite you again.",
            );
          }
        }

        const membership = await tx.membership.upsert({
          where: { tenantId_userId: { tenantId: invitation.tenantId, userId } },
          // Already a member somehow — take the invited role rather than failing.
          update: {
            role: invitation.role,
            status: "ACTIVE",
            joinedAt: new Date(),
            // Only ever set, never cleared: a plain ADMIN invitation accepted by
            // someone who already holds a diary must not silently unlink it.
            ...(invitation.providerId === null ? {} : { providerId: invitation.providerId }),
          },
          create: {
            tenantId: invitation.tenantId,
            userId,
            role: invitation.role,
            status: "ACTIVE",
            invitedByUserId: invitation.invitedByUserId,
            joinedAt: new Date(),
            providerId: invitation.providerId,
          },
        });

        await tx.invitation.update({
          where: { id: invitation.id },
          data: { status: "ACCEPTED", acceptedAt: new Date() },
        });

        return { membership, tenantId: invitation.tenantId };
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        // memberships_provider_id_key, and it can only be that one: the
        // invitations partial index is scoped `WHERE status = 'PENDING'`, so
        // moving a row *out* of PENDING can never violate it.
        //
        // Deliberately not the uniform "this invitation link is not valid" that
        // covers missing, used and revoked tokens. That uniformity is a security
        // property — a probe must not learn which it hit — and it does not apply
        // here: the token was valid, and the constraint that failed says nothing
        // about it.
        throw new ConflictError(
          ErrorCodes.VALIDATION_FAILED,
          "Someone else has already been given this provider's login. Ask the organization for a new invitation.",
        );
      }

      throw error;
    }
  }
}

/** Prisma's P2002 unique-constraint violation. */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { code?: unknown }).code === "P2002"
  );
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
