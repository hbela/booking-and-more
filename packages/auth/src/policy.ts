import { Permissions, ROLE_PERMISSIONS, type Permission, type Role } from "./roles.js";

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
  };
}

/** Tenant lifecycle, mirrored from the Prisma enum. */
export const TenantStatuses = {
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
 * A permission that comes in `:all` and `:own` flavours.
 *
 * Returns true if the actor has the `all` variant, or has the `own` variant and
 * the resource belongs to them. The `:own` permission on its own never
 * authorises anything — that separation is the whole point.
 */
export function canForProvider(
  actor: Actor,
  tenantId: string,
  providerId: string,
  permissions: { all: Permission; own: Permission },
): boolean {
  if (can(actor, tenantId, permissions.all)) return true;

  return (
    can(actor, tenantId, permissions.own) &&
    actor.membership?.providerId !== undefined &&
    actor.membership.providerId === providerId
  );
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
  return status === TenantStatuses.ACTIVE || status === TenantStatuses.TRIAL;
}

export function tenantIsReadable(status: TenantStatus): boolean {
  return status !== TenantStatuses.CLOSED;
}
