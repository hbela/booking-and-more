import { createHash, randomBytes } from "node:crypto";
import type { PrismaClient } from "@bam/db";
import { canHoldTenantMembership, Roles } from "@bam/auth";
import {
  ConflictError,
  daysUntil,
  ErrorCodes,
  ForbiddenError,
  restoredTenantStatus,
  NotFoundError,
} from "@bam/contracts";

import type { OrganizationSummary, ProvisionOrganizationBody } from "./platform.schemas.js";

/**
 * Platform administration. docs/phase-9-saas-administration.md.
 *
 * Provisioning is the operation the self-serve `POST /v1/tenants` route is not:
 * it creates an organization and grants OWNER to **somebody else**. That
 * distinction is what keeps CLAUDE.md rule 9 intact while letting a platform
 * admin create organizations (§1.3).
 */

export interface ProvisionResult {
  tenantId: string;
  /** Raw token. Shown once, never stored — only its hash is (tech-impl §34.4). */
  invitationToken: string;
}

export interface PlatformServiceOptions {
  /** How long a prospect organization has to subscribe before it is closed. */
  onboardingWindowDays: number;
  invitationExpiryHours: number;
}

export class PlatformService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly options: PlatformServiceOptions,
  ) {}

  /**
   * Create an organization and invite its owner, in one transaction.
   *
   * The transaction is not optional. An organization with no owner is
   * unreachable — nobody can accept, configure or pay for it — so a partial
   * failure would leave a row that only a DBA could clean up. The predecessor
   * did the same thing, and got that part right.
   *
   * What it got wrong was the next step: it generated a password, stored the
   * hash, and put the plaintext in the email. Here the owner receives a
   * single-use invitation link and chooses their own password (§2.5).
   */
  async provision(
    input: ProvisionOrganizationBody,
    provisionedByUserId: string,
  ): Promise<ProvisionResult> {
    const isInternal = input.mode === "INTERNAL";
    const email = input.ownerEmail.toLowerCase();

    await this.assertOwnerMayHoldMembership(email);
    await this.assertAvailable(input);

    // A prospect organization is gated and expires; an internal one is neither
    // (§2.2). An internal organization created PENDING_SUBSCRIPTION would be
    // unusable, which defeats the purpose of a demo.
    const subscribeBy = isInternal
      ? null
      : new Date(Date.now() + this.options.onboardingWindowDays * 24 * 60 * 60 * 1_000);

    const token = randomBytes(32).toString("base64url");

    try {
      const tenantId = await this.prisma.$transaction(async (tx) => {
        const tenant = await tx.tenant.create({
          data: {
            name: input.name,
            slug: input.slug,
            domain: input.domain,
            defaultTimezone: input.defaultTimezone,
            defaultLanguage: input.defaultLanguage,
            status: isInternal ? "ACTIVE" : "PENDING_SUBSCRIPTION",
            subscribeBy,
          },
        });

        // Keeps "every ACTIVE tenant has a subscription row" true, so quota
        // enforcement never has to cope with a missing plan (§2.2).
        if (isInternal) {
          await tx.subscription.create({
            data: { tenantId: tenant.id, plan: "INTERNAL", status: "NOT_APPLICABLE" },
          });
        }

        const expiresAt = new Date(
          Date.now() + this.options.invitationExpiryHours * 60 * 60 * 1_000,
        );

        await tx.invitation.create({
          data: {
            tenantId: tenant.id,
            email,
            role: Roles.OWNER,
            tokenHash: hashToken(token),
            status: "PENDING",
            expiresAt,
            invitedByUserId: provisionedByUserId,
          },
        });

        // The owner's email, requested rather than sent (tech-impl §12). Sending
        // it here would put a third-party HTTP call inside the transaction that
        // creates the organization; the predecessor did that and swallowed the
        // failure, so a provisioned owner who never got their link looked
        // identical to one who did.
        //
        // The payload carries the raw token because it is the only moment it
        // exists — the invitation stores a SHA-256 hash, by design (§34.4), so
        // the worker could not reconstruct the link later. The exposure is
        // bounded deliberately: `markProcessed` clears the payload as soon as
        // the event is dispatched, usually within seconds.
        await tx.outboxEvent.create({
          data: {
            tenantId: tenant.id,
            eventType: "ORGANIZATION_PROVISIONED",
            aggregateType: "Tenant",
            aggregateId: tenant.id,
            payload: {
              ownerEmail: email,
              ownerName: input.ownerName,
              invitationToken: token,
              expiresAt: expiresAt.toISOString(),
            },
          },
        });

        return tenant.id;
      });

      return { tenantId, invitationToken: token };
    } catch (error) {
      // Lost the race between the checks above and the insert. The unique
      // indexes are what actually guarantee this; the checks only buy a better
      // message (CLAUDE.md rule 14).
      this.translateUniqueViolation(error, input);
      throw error;
    }
  }

  /**
   * Reissue an owner's acceptance link.
   *
   * Needed because the invitation expires in 168 hours while the organization
   * has ~14 days to subscribe (§2.5). Without this, an owner who lets the link
   * lapse has an organization and no way into it — the most likely support
   * request in the whole flow.
   */
  async resendInvitation(
    tenantId: string,
    reissuedByUserId: string,
  ): Promise<{ acceptEmail: string; invitationToken: string; defaultLanguage: string }> {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      // defaultLanguage so the caller can build a locale-prefixed accept URL.
      select: { id: true, status: true, name: true, defaultLanguage: true },
    });

    if (!tenant) throw new NotFoundError("That organization does not exist.");

    const previous = await this.prisma.invitation.findFirst({
      where: { tenantId, role: Roles.OWNER },
      orderBy: { createdAt: "desc" },
      select: { id: true, email: true, status: true },
    });

    if (!previous) {
      throw new NotFoundError("That organization has no owner invitation to resend.");
    }

    if (previous.status === "ACCEPTED") {
      throw new ConflictError(
        ErrorCodes.VALIDATION_FAILED,
        "The owner has already accepted; there is nothing to resend.",
      );
    }

    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + this.options.invitationExpiryHours * 60 * 60 * 1_000);

    await this.prisma.$transaction(async (tx) => {
      // Supersede rather than update: the old link must stop working the moment
      // a new one exists, and the partial unique index expects one live
      // invitation per address.
      await tx.invitation.updateMany({
        where: { tenantId, email: previous.email, status: "PENDING" },
        data: { status: "REVOKED" },
      });

      await tx.invitation.create({
        data: {
          tenantId,
          email: previous.email,
          role: Roles.OWNER,
          tokenHash: hashToken(token),
          status: "PENDING",
          expiresAt,
          invitedByUserId: reissuedByUserId,
        },
      });

      // Reissuing without this produced a new link and no email — the route
      // returned 200, the operator saw success, and the owner got nothing.
      // Resending is *the* recovery path, so failing silently here fails
      // exactly when somebody is already stuck.
      //
      // A second event is correct rather than a duplicate: the notification
      // dedupe key is the event id, so each reissue legitimately sends again.
      await tx.outboxEvent.create({
        data: {
          tenantId,
          eventType: "ORGANIZATION_PROVISIONED",
          aggregateType: "Tenant",
          aggregateId: tenantId,
          payload: {
            ownerEmail: previous.email,
            // No name is stored on an invitation, and the original payload was
            // cleared once dispatched. The renderer falls back to the address.
            ownerName: null,
            invitationToken: token,
            expiresAt: expiresAt.toISOString(),
          },
        },
      });
    });

    return {
      acceptEmail: previous.email,
      invitationToken: token,
      defaultLanguage: tenant.defaultLanguage,
    };
  }

  async list(filter: {
    status?: string | undefined;
    search?: string | undefined;
  }): Promise<OrganizationSummary[]> {
    const search = filter.search?.trim();

    const tenants = await this.prisma.tenant.findMany({
      where: {
        ...(filter.status === undefined ? {} : { status: filter.status as "ACTIVE" | "SUSPENDED" }),
        ...(search === undefined || search === "" ? {} : { OR: searchTerms(search) }),
      },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        name: true,
        slug: true,
        domain: true,
        status: true,
        subscribeBy: true,
        createdAt: true,
        subscription: {
          select: {
            plan: true,
            status: true,
            currentPeriodEnd: true,
            cancelAtPeriodEnd: true,
          },
        },
        memberships: {
          where: { role: Roles.OWNER },
          take: 1,
          select: { user: { select: { email: true, name: true } } },
        },
        invitations: {
          where: { role: Roles.OWNER },
          orderBy: { createdAt: "desc" },
          take: 1,
          select: { email: true, status: true },
        },
      },
    });

    return tenants.map((tenant) => toSummary(tenant));
  }

  /**
   * Suspend an organization, or lift a suspension.
   *
   * `ACTIVE` from the caller means *restore access*, not *set the status to
   * ACTIVE* — where it actually lands is `restoredTenantStatus`, derived from
   * the subscription. Writing the literal back used to make a trialling
   * organization come back ACTIVE, and a prospect that had never paid come back
   * ACTIVE with no subscription row at all (phase-9 §2.2). The response carries
   * the status it really reached.
   */
  async setStatus(tenantId: string, status: "ACTIVE" | "SUSPENDED"): Promise<OrganizationSummary> {
    const existing = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { id: true, status: true, subscription: { select: { status: true } } },
    });

    if (!existing) throw new NotFoundError("That organization does not exist.");

    if (existing.status === "CLOSED") {
      throw new ConflictError(
        ErrorCodes.VALIDATION_FAILED,
        "A closed organization cannot be reactivated or suspended.",
      );
    }

    const next =
      status === "SUSPENDED" ? "SUSPENDED" : restoredTenantStatus(existing.subscription?.status);

    await this.prisma.tenant.update({ where: { id: tenantId }, data: { status: next } });

    const summary = (await this.list({})).find((entry) => entry.id === tenantId);

    // The row was found a moment ago and nothing deletes tenants, so this is
    // unreachable — but returning a wrong organization would be worse than an
    // error, so it is stated rather than assumed away with a `!`.
    if (!summary) throw new NotFoundError("That organization does not exist.");

    return summary;
  }

  /**
   * An owner who is a platform admin cannot be provisioned to — the same rule
   * that stops a platform admin creating a tenant for themselves, applied to
   * the person on the receiving end (CLAUDE.md rule 9).
   */
  private async assertOwnerMayHoldMembership(email: string): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { email },
      select: { isPlatformAdmin: true },
    });

    if (user && !canHoldTenantMembership(user)) {
      throw new ForbiddenError(
        "That user is a platform administrator and cannot own an organization.",
      );
    }
  }

  /** Better messages than a raw constraint violation; not the guarantee itself. */
  private async assertAvailable(input: ProvisionOrganizationBody): Promise<void> {
    const [bySlug, byDomain] = await Promise.all([
      this.prisma.tenant.findUnique({ where: { slug: input.slug }, select: { id: true } }),
      this.prisma.tenant.findUnique({ where: { domain: input.domain }, select: { id: true } }),
    ]);

    if (bySlug) {
      throw new ConflictError(
        ErrorCodes.VALIDATION_FAILED,
        `The slug "${input.slug}" is already taken.`,
        { field: "slug" },
      );
    }

    if (byDomain) {
      // The case this exists for: two salespeople working the same lead.
      throw new ConflictError(
        ErrorCodes.VALIDATION_FAILED,
        `An organization already exists for ${input.domain}.`,
        { field: "domain" },
      );
    }
  }

  private translateUniqueViolation(error: unknown, input: ProvisionOrganizationBody): void {
    if (!isUniqueViolation(error)) return;

    const target = uniqueViolationTarget(error);

    if (target.includes("domain")) {
      throw new ConflictError(
        ErrorCodes.VALIDATION_FAILED,
        `An organization already exists for ${input.domain}.`,
        { field: "domain" },
      );
    }

    if (target.includes("slug")) {
      throw new ConflictError(
        ErrorCodes.VALIDATION_FAILED,
        `The slug "${input.slug}" is already taken.`,
        { field: "slug" },
      );
    }
  }
}

interface TenantRow {
  id: string;
  name: string;
  slug: string;
  domain: string | null;
  status: string;
  subscribeBy: Date | null;
  createdAt: Date;
  subscription: {
    plan: string;
    status: string;
    currentPeriodEnd: Date | null;
    cancelAtPeriodEnd: boolean;
  } | null;
  memberships: { user: { email: string; name: string | null } }[];
  invitations: { email: string; status: string }[];
}

/**
 * What an operator may search an organization by.
 *
 * The owner is searchable as well as the organization, because the list shows
 * an owner column and "which organization does this person own?" is the
 * question that column invites. It used to match the tenant's own fields only,
 * so searching an owner's address returned an empty list rather than saying it
 * could not look that up — the organization simply vanished, owner column and
 * all.
 *
 * Restricted to the OWNER role on purpose: matching any member would return an
 * organization whose owner column names somebody else, which reads as the wrong
 * row rather than a wider search. Invitations are covered too, so an owner who
 * has not accepted yet — the case the column flags in amber — is findable by
 * the address the invitation went to.
 *
 * Every comparison is case-insensitive. `slug` and `domain` were not, so a
 * domain typed with a capital letter matched the name and missed the domain.
 */
function searchTerms(search: string) {
  const like = { contains: search, mode: "insensitive" as const };

  return [
    { name: like },
    { slug: like },
    { domain: like },
    {
      memberships: { some: { role: Roles.OWNER, user: { OR: [{ email: like }, { name: like }] } } },
    },
    { invitations: { some: { role: Roles.OWNER, email: like } } },
  ];
}

function toSummary(tenant: TenantRow): OrganizationSummary {
  const member = tenant.memberships[0];
  const invitation = tenant.invitations[0];

  // The accepted owner if there is one, otherwise whoever was invited. Both
  // matter to an operator: "who owns this" and "who has not clicked the link".
  const owner =
    member !== undefined
      ? { email: member.user.email, name: member.user.name, accepted: true }
      : invitation !== undefined
        ? { email: invitation.email, name: null, accepted: false }
        : null;

  return {
    id: tenant.id,
    name: tenant.name,
    slug: tenant.slug,
    domain: tenant.domain,
    status: tenant.status as OrganizationSummary["status"],
    subscribeBy: tenant.subscribeBy?.toISOString() ?? null,
    daysRemaining: daysUntil(tenant.subscribeBy),
    createdAt: tenant.createdAt.toISOString(),
    owner,
    subscription:
      tenant.subscription === null
        ? null
        : {
            plan: tenant.subscription.plan as SubscriptionSummary["plan"],
            status: tenant.subscription.status as SubscriptionSummary["status"],
            currentPeriodEnd: tenant.subscription.currentPeriodEnd?.toISOString() ?? null,
            cancelAtPeriodEnd: tenant.subscription.cancelAtPeriodEnd,
          },
  };
}

/** The non-null branch of the summary's subscription, named so the casts read. */
type SubscriptionSummary = NonNullable<OrganizationSummary["subscription"]>;

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "P2002"
  );
}

function uniqueViolationTarget(error: unknown): string {
  const meta = (error as { meta?: { target?: unknown } }).meta;
  return JSON.stringify(meta?.target ?? "");
}
