/**
 * Roles and permissions. tech-impl §8.3, §8.4.
 *
 * ## Where a role lives
 *
 * A role is a property of a **membership** — a (tenant, user) pair — never of a
 * user. The same person can be an OWNER of one clinic and an ASSISTANT at
 * another, and there is no such thing as "a PROVIDER" in the abstract.
 *
 * The predecessor project had `User.role` (global) and `Member.role`
 * (per-organisation) side by side, with some guards reading one and some the
 * other. That is an authorization bug waiting to happen, and it is the reason
 * this file exists as the single source of truth.
 *
 * The one exception is PLATFORM_ADMIN, which is deliberately *not* a role:
 * operating the platform is not scoped to a tenant, so it is a boolean flag on
 * the user (`User.isPlatformAdmin`). Keeping it out of the role enum stops it
 * from being grantable through the ordinary invitation flow.
 */

export const Roles = {
  OWNER: "OWNER",
  ADMIN: "ADMIN",
  PROVIDER: "PROVIDER",
  ASSISTANT: "ASSISTANT",
  CUSTOMER: "CUSTOMER",
} as const;

export type Role = (typeof Roles)[keyof typeof Roles];

export const ALL_ROLES: readonly Role[] = Object.values(Roles);

/**
 * Roles that can be handed out through an invitation.
 *
 * CUSTOMER is excluded: customers arrive by booking, not by invitation, and
 * inviting someone as a CUSTOMER of a tenant would be meaningless.
 */
export const INVITABLE_ROLES: readonly Role[] = [
  Roles.OWNER,
  Roles.ADMIN,
  Roles.PROVIDER,
  Roles.ASSISTANT,
];

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

/**
 * Explicit permissions rather than role checks scattered through handlers
 * (tech-impl §8.4). Handlers ask "may this actor do X", never "is this actor an
 * ADMIN" — so adding a role later does not mean auditing every route.
 */
export const Permissions = {
  TENANT_MANAGE: "tenant:manage",
  TENANT_READ: "tenant:read",
  BILLING_MANAGE: "billing:manage",

  MEMBER_MANAGE: "member:manage",
  MEMBER_READ: "member:read",

  PROVIDER_MANAGE: "provider:manage",
  SERVICE_MANAGE: "service:manage",
  LOCATION_MANAGE: "location:manage",

  AVAILABILITY_MANAGE_ALL: "availability:manage:all",
  AVAILABILITY_MANAGE_OWN: "availability:manage:own",

  /**
   * Connecting and disconnecting a Google Calendar (Epic 6).
   *
   * Mirrors the availability pair, and for the same reason: a provider owns
   * their own diary, so connecting *their* calendar is theirs to do, while an
   * administrator may set one up on anybody's behalf. Like every `:own`
   * permission these are resource-scoped — the permission alone is never enough
   * and `canManageIntegration` in policy.ts does the ownership half.
   */
  INTEGRATION_MANAGE_ALL: "integration:manage:all",
  INTEGRATION_MANAGE_OWN: "integration:manage:own",

  BOOKING_READ_ALL: "booking:read:all",
  BOOKING_READ_OWN: "booking:read:own",
  BOOKING_MANAGE_ALL: "booking:manage:all",
  BOOKING_MANAGE_OWN: "booking:manage:own",

  AUDIT_READ: "audit:read",
  USAGE_READ: "usage:read",
} as const;

export type Permission = (typeof Permissions)[keyof typeof Permissions];

/**
 * Role → permissions.
 *
 * Note what OWNER does *not* have that ADMIN does not either: nothing here
 * grants cross-tenant access. Every permission is evaluated inside a single
 * tenant's context; there is no permission that means "any tenant".
 */
export const ROLE_PERMISSIONS: Readonly<Record<Role, readonly Permission[]>> = {
  // Billing and tenant settings are the owner's alone (PRD §9.2).
  [Roles.OWNER]: [
    Permissions.TENANT_MANAGE,
    Permissions.TENANT_READ,
    Permissions.BILLING_MANAGE,
    Permissions.MEMBER_MANAGE,
    Permissions.MEMBER_READ,
    Permissions.PROVIDER_MANAGE,
    Permissions.SERVICE_MANAGE,
    Permissions.LOCATION_MANAGE,
    Permissions.AVAILABILITY_MANAGE_ALL,
    Permissions.AVAILABILITY_MANAGE_OWN,
    Permissions.INTEGRATION_MANAGE_ALL,
    Permissions.INTEGRATION_MANAGE_OWN,
    Permissions.BOOKING_READ_ALL,
    Permissions.BOOKING_READ_OWN,
    Permissions.BOOKING_MANAGE_ALL,
    Permissions.BOOKING_MANAGE_OWN,
    Permissions.AUDIT_READ,
    Permissions.USAGE_READ,
  ],

  // Everything operational, but not billing and not tenant settings.
  [Roles.ADMIN]: [
    Permissions.TENANT_READ,
    Permissions.MEMBER_MANAGE,
    Permissions.MEMBER_READ,
    Permissions.PROVIDER_MANAGE,
    Permissions.SERVICE_MANAGE,
    Permissions.LOCATION_MANAGE,
    Permissions.AVAILABILITY_MANAGE_ALL,
    Permissions.AVAILABILITY_MANAGE_OWN,
    Permissions.INTEGRATION_MANAGE_ALL,
    Permissions.INTEGRATION_MANAGE_OWN,
    Permissions.BOOKING_READ_ALL,
    Permissions.BOOKING_READ_OWN,
    Permissions.BOOKING_MANAGE_ALL,
    Permissions.BOOKING_MANAGE_OWN,
    Permissions.AUDIT_READ,
    Permissions.USAGE_READ,
  ],

  // Own schedule only. The :own permissions are resource-scoped and always
  // need the ownership check in policy.ts — the permission alone is not enough.
  [Roles.PROVIDER]: [
    Permissions.TENANT_READ,
    Permissions.MEMBER_READ,
    Permissions.AVAILABILITY_MANAGE_OWN,
    Permissions.INTEGRATION_MANAGE_OWN,
    Permissions.BOOKING_READ_OWN,
    Permissions.BOOKING_MANAGE_OWN,
  ],

  // Front desk: manages everyone's bookings, touches no settings and no billing
  // (PRD §6.3).
  [Roles.ASSISTANT]: [
    Permissions.TENANT_READ,
    Permissions.MEMBER_READ,
    Permissions.BOOKING_READ_ALL,
    Permissions.BOOKING_MANAGE_ALL,
  ],

  // Customers hold no staff permissions. Their own bookings are reached through
  // a management token or their own account, checked by resource ownership
  // rather than by this table (PRD §9.18).
  [Roles.CUSTOMER]: [],
};

export function permissionsForRole(role: Role): readonly Permission[] {
  return ROLE_PERMISSIONS[role];
}
