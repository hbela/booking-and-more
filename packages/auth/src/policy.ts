import {
  DELEGATION_SCOPE_PERMISSIONS,
  Permissions,
  ROLE_PERMISSIONS,
  type DelegationScope,
  type Permission,
  type Role,
} from "./roles.js";

/**
 * Authorization decisions, as pure functions.
 *
 * Nothing here touches Fastify, Prisma, or the network, so every rule is
 * unit-testable and none of them can accidentally depend on ambient request
 * state. Route handlers call these; they never re-implement the logic
 * (CLAUDE.md rule 8).
 */

/** Membership status. A membership only grants anything while ACTIVE. */
export const MembershipStatuses = {
  INVITED: "INVITED",
  ACTIVE: "ACTIVE",
  SUSPENDED: "SUSPENDED",
} as const;

export type MembershipStatus = (typeof MembershipStatuses)[keyof typeof MembershipStatuses];

/**
 * Diaries handed to this membership, indexed by the `:delegated` permission
 * each grant confers.
 *
 * Keyed by permission rather than by scope so that `canForProvider` is one
 * lookup with no scope vocabulary in it — the word "BOOKINGS" lives in exactly
 * one table (docs/phase-3-4-diary-delegation.md §2.4).
 */
export type DelegatedProviderIds = Readonly<Partial<Record<Permission, readonly string[]>>>;

/**
 * Who is making the request, already resolved against the database.
 *
 * Every field here is server-derived. Nothing on this object may come from a
 * client-supplied header or body (tech-impl §7.2).
 */
export interface Actor {
  userId: string;
  /** Platform operators. Not a tenant role — see roles.ts. */
  isPlatformAdmin: boolean;
  /** Absent when the user is authenticated but has no membership in this tenant. */
  membership?: {
    id: string;
    tenantId: string;
    role: Role;
    status: MembershipStatus;
    /** Set when this membership *is* a provider, linking role to a schedule. */
    providerId?: string | undefined;
    /**
     * Diaries this membership has been handed.
     *
     * Inside `membership`, not beside it, and that placement is the whole
     * per-tenant safety argument: the set can only be reached through the
     * object that also carries `tenantId`, so there is no representable state
     * in which one tenant's grants are consulted for another tenant's
     * resource. A person assisting at two clinics resolves a different
     * membership per request and therefore a different set.
     * docs/phase-3-4-diary-delegation.md §2.4.
     */
    delegated?: DelegatedProviderIds | undefined;
  };
}

/**
 * Turn grant rows into the permission-indexed set the Actor carries.
 *
 * Pure and total: an unrecognised scope string contributes nothing rather than
 * throwing, because a database enum value newer than this build must fail
 * closed, not 500 every request that touches it.
 */
export function delegatedProviderIdsFrom(
  grants: readonly { providerId: string; scopes: readonly string[] }[],
): DelegatedProviderIds {
  const byPermission = new Map<Permission, Set<string>>();

  for (const grant of grants) {
    for (const scope of grant.scopes) {
      const permissions = DELEGATION_SCOPE_PERMISSIONS[scope as DelegationScope] as
        | readonly Permission[]
        | undefined;
      if (!permissions) continue;

      for (const permission of permissions) {
        const bucket = byPermission.get(permission) ?? new Set<string>();
        bucket.add(grant.providerId);
        byPermission.set(permission, bucket);
      }
    }
  }

  return Object.fromEntries([...byPermission].map(([permission, ids]) => [permission, [...ids]]));
}

/** Tenant lifecycle, mirrored from the Prisma enum. */
export const TenantStatuses = {
  /** Provisioned, owner can sign in, nothing configurable until they subscribe. */
  PENDING_SUBSCRIPTION: "PENDING_SUBSCRIPTION",
  TRIAL: "TRIAL",
  ACTIVE: "ACTIVE",
  SUSPENDED: "SUSPENDED",
  CLOSED: "CLOSED",
} as const;

export type TenantStatus = (typeof TenantStatuses)[keyof typeof TenantStatuses];

// ---------------------------------------------------------------------------
// Core predicates
// ---------------------------------------------------------------------------

/** True when the actor holds an active membership in exactly this tenant. */
export function isMemberOf(actor: Actor, tenantId: string): boolean {
  const membership = actor.membership;
  return (
    membership !== undefined &&
    membership.tenantId === tenantId &&
    membership.status === MembershipStatuses.ACTIVE
  );
}

/**
 * Does the actor hold `permission` in `tenantId`?
 *
 * Deliberately takes the tenant ID rather than trusting `actor.membership` to
 * be for the right tenant: a resolved actor plus a resource from a *different*
 * tenant is exactly the confused-deputy case this must reject.
 */
export function can(actor: Actor, tenantId: string, permission: Permission): boolean {
  // Platform admins operate the platform, so they bypass tenant permissions.
  // They are created out-of-band (never by invitation) and every action they
  // take is audited with actorType PLATFORM_ADMIN.
  if (actor.isPlatformAdmin) return true;

  if (!isMemberOf(actor, tenantId)) return false;

  // isMemberOf has established membership is present and for this tenant.
  const role = actor.membership!.role;
  return ROLE_PERMISSIONS[role].includes(permission);
}

/**
 * A permission that comes in `:all`, `:own` and `:delegated` flavours.
 *
 * Three branches, tried in that order:
 *
 *   1. `:all` — the owner and the administrator, for whom ownership is
 *      irrelevant. Also where a platform admin returns, since `can()` is
 *      unconditionally true for them.
 *   2. `:own` — the resource is the actor's own diary.
 *   3. `:delegated` — the diary was handed to this membership
 *      (docs/phase-3-4-diary-delegation.md §2.4). The key is *optional*, and a
 *      rule that is not delegable simply omits it: that is how
 *      `canManageIntegration` stays closed to an assistant, since a connected
 *      calendar is a setting rather than a day's work.
 *
 * Neither `:own` nor `:delegated` authorises anything on its own — that
 * separation is the whole point, and it is why an unlinked provider and an
 * assistant with no grants both fail closed rather than matching everything.
 */
export function canForProvider(
  actor: Actor,
  tenantId: string,
  providerId: string,
  permissions: { all: Permission; own: Permission; delegated?: Permission },
): boolean {
  if (can(actor, tenantId, permissions.all)) return true;

  const membership = actor.membership;

  if (
    can(actor, tenantId, permissions.own) &&
    membership?.providerId !== undefined &&
    membership.providerId === providerId
  ) {
    return true;
  }

  if (permissions.delegated === undefined) return false;
  if (!can(actor, tenantId, permissions.delegated)) return false;

  // `isMemberOf` again, and not redundantly: `can()` short-circuits true for a
  // platform admin without ever comparing tenants, so without this a membership
  // resolved for a *different* tenant could supply the set. A platform admin
  // holds no memberships (rule 9) and has already returned at branch 1, which
  // makes this unreachable today — and exactly the sort of unreachable that
  // stops being so.
  if (!isMemberOf(actor, tenantId)) return false;

  return (membership?.delegated?.[permissions.delegated] ?? []).includes(providerId);
}

/**
 * Which diaries a list may cover.
 *
 * A discriminated union rather than `string[] | null`, because the failure this
 * exists to prevent is an empty set being read as "no filter" and listing the
 * whole tenant (rule 10). A caller that forgets the `all` case gets a type
 * error; a caller handed `{ kind: "some", providerIds: [] }` cannot spell it
 * the same way as no filter. docs/phase-3-4-diary-delegation.md §4.3.
 */
export type ProviderScope = { kind: "all" } | { kind: "some"; providerIds: readonly string[] };

export function providerIdsInScope(
  actor: Actor,
  tenantId: string,
  permissions: { all: Permission; own: Permission; delegated: Permission },
): ProviderScope {
  if (can(actor, tenantId, permissions.all)) return { kind: "all" };

  const membership = actor.membership;
  const ids = new Set<string>();

  if (can(actor, tenantId, permissions.own) && membership?.providerId !== undefined) {
    ids.add(membership.providerId);
  }

  // Same tenant re-assertion as canForProvider, for the same reason.
  if (can(actor, tenantId, permissions.delegated) && isMemberOf(actor, tenantId)) {
    for (const providerId of membership?.delegated?.[permissions.delegated] ?? []) {
      ids.add(providerId);
    }
  }

  return { kind: "some", providerIds: [...ids] };
}

// ---------------------------------------------------------------------------
// Named rules
//
// Handlers read better as `canBlockProviderTime(actor, tenantId, providerId)`
// than as a permission-pair lookup, and naming the rule gives the test suite
// something meaningful to assert on.
// ---------------------------------------------------------------------------

/** tech-impl §8.4's worked example. */
export function canBlockProviderTime(actor: Actor, tenantId: string, providerId: string): boolean {
  return canForProvider(actor, tenantId, providerId, {
    all: Permissions.AVAILABILITY_MANAGE_ALL,
    own: Permissions.AVAILABILITY_MANAGE_OWN,
    delegated: Permissions.AVAILABILITY_MANAGE_DELEGATED,
  });
}

/**
 * Connecting or disconnecting a calendar for one provider's diary.
 * docs/phase-6-google-calendar-part-1.md.
 *
 * The same `:all` / `:own` shape as blocking time out, and deliberately so: a
 * connected calendar *is* an availability decision, made through a third party.
 * A provider may wire up their own; an administrator may do it for anybody.
 *
 * Note what this does **not** decide — whose Google account may be attached.
 * That is settled by consent at Google itself, which is a stronger check than
 * any table here: nobody can connect an account they cannot sign into.
 *
 * **No `delegated` key, deliberately.** Diary delegation hands over the day's
 * work — hours, time off, appointments — and a connected calendar is neither:
 * it is a setting, and settings stay with whoever configures the organization.
 * The omission is the whole enforcement; there is no scope that could reach
 * this rule. docs/phase-3-4-diary-delegation.md §2.4.
 */
export function canManageIntegration(
  actor: Actor,
  tenantId: string,
  providerId: string,
): boolean {
  return canForProvider(actor, tenantId, providerId, {
    all: Permissions.INTEGRATION_MANAGE_ALL,
    own: Permissions.INTEGRATION_MANAGE_OWN,
  });
}

/**
 * May this actor decide who runs the diaries in this organization?
 *
 * **The owner, and nobody else.** Not the administrator, who holds
 * `availability:manage:all` and may edit every schedule in the clinic; not the
 * provider whose diary it is. docs/phase-3-4-diary-delegation.md §2.3.
 *
 * Tenant-wide rather than per-provider, and that shape is the decision. Who may
 * *work* a diary is a question about that diary, which is why every rule above
 * takes a `providerId`. Who may put a member on one is a question about the
 * organization's staffing, and it has one answer for the whole organization.
 *
 * Its own permission rather than a reading of the availability ones, because
 * ADMIN holds those: expressing the rule as "may manage availability" would
 * have handed staffing to administrators silently, and nothing would have said
 * so. It is also what makes re-delegation impossible without a special case —
 * an ASSISTANT simply does not hold `delegation:manage`, so a delegate cannot
 * pass a diary on and there is no depth counter or cycle check anywhere.
 */
export function canManageDelegations(actor: Actor, tenantId: string): boolean {
  return can(actor, tenantId, Permissions.DELEGATION_MANAGE);
}

/**
 * May this actor see who runs this diary?
 *
 * Wider than managing it, and only just: the owner, plus the provider whose
 * diary it is. A provider does not choose their assistants and must still be
 * able to see who has been given their week — being told is the least that
 * `phase-2-3` §2.7's "availability belongs to the provider" can survive on once
 * the choosing moved to the owner.
 *
 * Expressed through `canForProvider` with **no delegated key**, so an assistant
 * cannot enumerate the others: knowing who else holds a diary is not part of
 * running it.
 */
export function canReadProviderDelegates(
  actor: Actor,
  tenantId: string,
  providerId: string,
): boolean {
  return canForProvider(actor, tenantId, providerId, {
    all: Permissions.DELEGATION_MANAGE,
    own: Permissions.AVAILABILITY_MANAGE_OWN,
  });
}

export function canReadProviderBookings(
  actor: Actor,
  tenantId: string,
  providerId: string,
): boolean {
  return canForProvider(actor, tenantId, providerId, {
    all: Permissions.BOOKING_READ_ALL,
    own: Permissions.BOOKING_READ_OWN,
    delegated: Permissions.BOOKING_READ_DELEGATED,
  });
}

export function canManageProviderBookings(
  actor: Actor,
  tenantId: string,
  providerId: string,
): boolean {
  return canForProvider(actor, tenantId, providerId, {
    all: Permissions.BOOKING_MANAGE_ALL,
    own: Permissions.BOOKING_MANAGE_OWN,
    delegated: Permissions.BOOKING_MANAGE_DELEGATED,
  });
}

/**
 * Only an owner may change another member's role, and nobody may change their
 * own — an owner demoting themselves can strand a tenant with no owner, and a
 * self-promotion path is a privilege-escalation bug by construction.
 */
export function canChangeMemberRole(
  actor: Actor,
  tenantId: string,
  targetMembershipId: string,
): boolean {
  if (actor.membership?.id === targetMembershipId && !actor.isPlatformAdmin) return false;
  return can(actor, tenantId, Permissions.MEMBER_MANAGE);
}

/** Removing yourself is allowed (leaving a tenant); the last owner is guarded in the service. */
export function canRemoveMember(actor: Actor, tenantId: string): boolean {
  return can(actor, tenantId, Permissions.MEMBER_MANAGE);
}

// ---------------------------------------------------------------------------
// Separation of duties
// ---------------------------------------------------------------------------

/**
 * May this user belong to a tenant at all?
 *
 * No, if they operate the platform. An operator is not one of the platform's
 * customers, and the two roles pull in opposite directions:
 *
 *   - `can()` already returns true for a platform admin in *every* tenant, so a
 *     membership grants them nothing. It is not a privilege, only a claim.
 *   - Every action they take is audited as `PLATFORM_ADMIN` (audit.plugin.ts).
 *     An owner who is also an operator produces an audit trail in which their
 *     ordinary work as an owner is indistinguishable from platform
 *     intervention, which is exactly the distinction an audit trail exists to
 *     make.
 *   - It keeps the operator's account out of customer data by construction,
 *     rather than by their remembering not to look.
 *
 * Enforced in both directions — a platform admin cannot acquire a membership,
 * and a user holding memberships cannot be made a platform admin — because a
 * one-way guard is satisfied by doing the two steps in the other order.
 */
export function canHoldTenantMembership(user: { isPlatformAdmin: boolean }): boolean {
  return !user.isPlatformAdmin;
}

/**
 * The same rule from the other side, for `pnpm db:grant-platform-admin`.
 *
 * Takes a count rather than the memberships themselves: the caller has to run
 * the query either way, and the rule only cares whether the answer is zero.
 */
export function canBecomePlatformAdmin(user: { membershipCount: number }): boolean {
  return user.membershipCount === 0;
}

// ---------------------------------------------------------------------------
// Tenant lifecycle
// ---------------------------------------------------------------------------

/**
 * May this tenant accept writes at all?
 *
 * Checked before permissions, because a suspended tenant must reject even its
 * owner's writes (Epic 9 exit criterion: "suspended tenants cannot accept new
 * bookings"). Reads stay available so people can still see their data and pay
 * an invoice.
 *
 * The predecessor did this with a database round-trip inside each handler,
 * applied inconsistently. Here it is a pure function over already-loaded tenant
 * state, called from one preHandler.
 */
export function tenantAcceptsWrites(status: TenantStatus): boolean {
  // Written as an allow-list rather than `!== SUSPENDED`, which is why
  // PENDING_SUBSCRIPTION was already gated the moment it was added. That is
  // load-bearing: it is the activation gate for the whole onboarding flow
  // (phase-9 §2.4), so it is asserted in policy.test.ts rather than left to
  // luck. Inverting this into a deny-list would silently un-gate every future
  // status somebody forgets to add.
  return status === TenantStatuses.ACTIVE || status === TenantStatuses.TRIAL;
}

/**
 * May this tenant be read?
 *
 * Yes unless closed. An owner in PENDING_SUBSCRIPTION must be able to sign in
 * and see their organization — that is where the subscribe action lives, and
 * an organization nobody can look at cannot be paid for.
 */
export function tenantIsReadable(status: TenantStatus): boolean {
  return status !== TenantStatuses.CLOSED;
}
