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

  /**
   * Deciding who runs a provider's diary.
   *
   * Tenant-wide and deliberately **not** one of the `:all` / `:own` pairs. Who
   * may work a diary is a question about that diary; who may *hand it to
   * somebody* is a question about the organization's staff, and the answer is
   * the owner. docs/phase-3-4-diary-delegation.md §2.3.
   *
   * Note what this being its own permission buys: ADMIN holds
   * `availability:manage:all` and can edit every diary in the clinic, and still
   * does not hold this. Expressing the rule as "may manage availability" would
   * have handed it to them silently.
   */
  DELEGATION_MANAGE: "delegation:manage",

  AVAILABILITY_MANAGE_ALL: "availability:manage:all",
  AVAILABILITY_MANAGE_OWN: "availability:manage:own",
  /**
   * Managing the schedule of a diary that has been *handed* to you.
   *
   * A third flavour beside `:all` and `:own`, and resource-scoped exactly like
   * `:own`: the permission alone never authorises anything, and
   * `canForProvider` in policy.ts does the "which diary" half against the
   * grants hanging off the actor's membership.
   * docs/phase-3-4-diary-delegation.md §2.1.
   */
  AVAILABILITY_MANAGE_DELEGATED: "availability:manage:delegated",

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
  BOOKING_READ_DELEGATED: "booking:read:delegated",
  BOOKING_MANAGE_ALL: "booking:manage:all",
  BOOKING_MANAGE_OWN: "booking:manage:own",
  BOOKING_MANAGE_DELEGATED: "booking:manage:delegated",

  AUDIT_READ: "audit:read",
  USAGE_READ: "usage:read",
  ASSISTANT_MANAGE: "assistant:manage",
  CONVERSATION_READ_ALL: "conversation:read:all",
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
    Permissions.DELEGATION_MANAGE,
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
    Permissions.ASSISTANT_MANAGE,
    Permissions.CONVERSATION_READ_ALL,
  ],

  // Everything operational, but not billing, not tenant settings, and — since
  // diary delegation — not deciding who runs a diary. An ADMIN may edit every
  // schedule in the clinic and may not hand one to anybody: staffing is the
  // owner's (docs/phase-3-4-diary-delegation.md §2.3). The gap is deliberate
  // and is asserted in policy.test.ts, because it is the one line here that
  // looks like an omission.
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
    Permissions.ASSISTANT_MANAGE,
    Permissions.CONVERSATION_READ_ALL,
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

  // Front desk: delegated rather than universal. An assistant reaches the
  // diaries the providers handed them, and no others
  // (docs/phase-3-4-diary-delegation.md §2.1). Still no settings and no billing
  // (PRD §6.3).
  //
  // Held `booking:read:all` and `booking:manage:all` until 2026-08-17. The
  // migration that removed them backfilled a BOOKINGS grant from every diary,
  // so no front desk lost access on the day (§2.2).
  //
  // OWNER and ADMIN deliberately do *not* hold the `:delegated` permissions.
  // They hold the `:all` variant, which subsumes them, and a role holding both
  // makes a branch of canForProvider that can never be reached — dead weight in
  // the one table nobody may misread. Asserted in policy.test.ts.
  [Roles.ASSISTANT]: [
    Permissions.TENANT_READ,
    Permissions.MEMBER_READ,
    Permissions.AVAILABILITY_MANAGE_DELEGATED,
    Permissions.BOOKING_READ_DELEGATED,
    Permissions.BOOKING_MANAGE_DELEGATED,
  ],

  // Customers hold no staff permissions. Their own bookings are reached through
  // a management token or their own account, checked by resource ownership
  // rather than by this table (PRD §9.18).
  [Roles.CUSTOMER]: [],
};

export function permissionsForRole(role: Role): readonly Permission[] {
  return ROLE_PERMISSIONS[role];
}

// ---------------------------------------------------------------------------
// Delegation scopes
//
// docs/phase-3-4-diary-delegation.md §2.4. A provider hands their diary to
// somebody else; a grant says which halves of the job come with it.
// ---------------------------------------------------------------------------

/** Mirrors the `DelegationScope` Prisma enum. */
export const DelegationScopes = {
  AVAILABILITY: "AVAILABILITY",
  BOOKINGS: "BOOKINGS",
} as const;

export type DelegationScope = (typeof DelegationScopes)[keyof typeof DelegationScopes];

export const ALL_DELEGATION_SCOPES: readonly DelegationScope[] = Object.values(DelegationScopes);

/**
 * Scope → the permissions a grant of it confers.
 *
 * The single translation point, and the only place in the system that knows the
 * word "BOOKINGS" means anything. `canForProvider` never learns it: the rule is
 * handed a permission and looks up the provider ids indexed by that permission,
 * so adding a scope is an edit here and nowhere else (rule 10).
 *
 * It is also what keeps `canManageIntegration` closed to a delegate — that rule
 * is simply never given a `delegated` key, so no scope can reach it. A
 * connected calendar is a setting, not a day's work.
 */
export const DELEGATION_SCOPE_PERMISSIONS: Readonly<
  Record<DelegationScope, readonly Permission[]>
> = {
  [DelegationScopes.AVAILABILITY]: [Permissions.AVAILABILITY_MANAGE_DELEGATED],
  [DelegationScopes.BOOKINGS]: [
    Permissions.BOOKING_READ_DELEGATED,
    Permissions.BOOKING_MANAGE_DELEGATED,
  ],
};

/** Every permission that only a delegation can satisfy. */
export const DELEGATED_PERMISSIONS: readonly Permission[] = Object.values(
  DELEGATION_SCOPE_PERMISSIONS,
).flat();

/**
 * Would a grant to this role do anything?
 *
 * Asked as a permission question rather than `role === "ASSISTANT"` (rule 10),
 * and three things follow — only the first of which was the goal:
 *
 *   1. Re-scoping which roles may receive a diary is an edit to
 *      ROLE_PERMISSIONS and nothing else.
 *   2. `tenant-context.plugin.ts` loads grants for exactly the roles that could
 *      use them, so every other request costs what it cost before — and a role
 *      that gains a `:delegated` permission later starts loading its grants
 *      with no edit to the plugin.
 *   3. A grant held by a membership whose role no longer receives delegations
 *      confers nothing, with no sweep and no cascade
 *      (docs/phase-3-4-diary-delegation.md §2.8).
 */
export function roleCanReceiveDelegation(role: Role): boolean {
  return ROLE_PERMISSIONS[role].some((permission) => DELEGATED_PERMISSIONS.includes(permission));
}
