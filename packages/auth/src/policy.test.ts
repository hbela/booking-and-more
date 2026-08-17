import { describe, expect, it } from "vitest";
import {
  ALL_DELEGATION_SCOPES,
  ALL_ROLES,
  DELEGATED_PERMISSIONS,
  DELEGATION_SCOPE_PERMISSIONS,
  INVITABLE_ROLES,
  Permissions,
  ROLE_PERMISSIONS,
  Roles,
  roleCanReceiveDelegation,
  type Role,
} from "./roles.js";
import {
  MembershipStatuses,
  TenantStatuses,
  type Actor,
  type DelegatedProviderIds,
  can,
  canDelegateProviderDiary,
  delegatedProviderIdsFrom,
  providerIdsInScope,
  canBecomePlatformAdmin,
  canBlockProviderTime,
  canManageIntegration,
  canChangeMemberRole,
  canHoldTenantMembership,
  canManageProviderBookings,
  canReadProviderBookings,
  isMemberOf,
  tenantAcceptsWrites,
  tenantIsReadable,
} from "./policy.js";

const TENANT_A = "tenant_a";
const TENANT_B = "tenant_b";

// Module scope rather than inside one describe: the delegation blocks below ask
// the same questions of the same two diaries.
const PROVIDER_SELF = "provider_self";
const PROVIDER_OTHER = "provider_other";

function actor(overrides: {
  role?: Role;
  tenantId?: string;
  status?: (typeof MembershipStatuses)[keyof typeof MembershipStatuses];
  providerId?: string;
  delegated?: DelegatedProviderIds;
  isPlatformAdmin?: boolean;
  noMembership?: boolean;
}): Actor {
  const base: Actor = {
    userId: "user_1",
    isPlatformAdmin: overrides.isPlatformAdmin ?? false,
  };

  if (overrides.noMembership) return base;

  return {
    ...base,
    membership: {
      id: "membership_1",
      tenantId: overrides.tenantId ?? TENANT_A,
      role: overrides.role ?? Roles.ADMIN,
      status: overrides.status ?? MembershipStatuses.ACTIVE,
      providerId: overrides.providerId,
      delegated: overrides.delegated,
    },
  };
}

/** A grant of every permission `scope` confers, over `providerIds`. */
function grantOf(
  scope: (typeof ALL_DELEGATION_SCOPES)[number],
  ...providerIds: string[]
): DelegatedProviderIds {
  return delegatedProviderIdsFrom(providerIds.map((providerId) => ({ providerId, scopes: [scope] })));
}

describe("isMemberOf", () => {
  it("accepts an active membership in the same tenant", () => {
    expect(isMemberOf(actor({}), TENANT_A)).toBe(true);
  });

  it("rejects a membership in a different tenant", () => {
    expect(isMemberOf(actor({ tenantId: TENANT_B }), TENANT_A)).toBe(false);
  });

  it("rejects an invited-but-not-joined membership", () => {
    expect(isMemberOf(actor({ status: MembershipStatuses.INVITED }), TENANT_A)).toBe(false);
  });

  it("rejects a suspended membership", () => {
    expect(isMemberOf(actor({ status: MembershipStatuses.SUSPENDED }), TENANT_A)).toBe(false);
  });

  it("rejects a user with no membership at all", () => {
    expect(isMemberOf(actor({ noMembership: true }), TENANT_A)).toBe(false);
  });
});

describe("can — tenant isolation", () => {
  /**
   * The central guarantee of the whole authorization layer: a perfectly valid
   * actor, asked about a *different* tenant, must be refused every permission.
   * This is the confused-deputy case that let the predecessor project's
   * handlers read other tenants' data.
   */
  it("refuses every permission when the resource belongs to another tenant", () => {
    for (const role of ALL_ROLES) {
      const subject = actor({ role, tenantId: TENANT_A });

      for (const permission of Object.values(Permissions)) {
        expect(
          can(subject, TENANT_B, permission),
          `${role} must not hold ${permission} in another tenant`,
        ).toBe(false);
      }
    }
  });

  it("grants exactly the permissions listed for the role, and nothing else", () => {
    for (const role of ALL_ROLES) {
      const subject = actor({ role });
      const granted = ROLE_PERMISSIONS[role];

      for (const permission of Object.values(Permissions)) {
        expect(can(subject, TENANT_A, permission), `${role} / ${permission}`).toBe(
          granted.includes(permission),
        );
      }
    }
  });

  it("refuses everything to a suspended member, whatever their role", () => {
    for (const role of ALL_ROLES) {
      const subject = actor({ role, status: MembershipStatuses.SUSPENDED });
      for (const permission of Object.values(Permissions)) {
        expect(can(subject, TENANT_A, permission)).toBe(false);
      }
    }
  });
});

describe("can — role boundaries", () => {
  it("gives billing only to the owner", () => {
    expect(can(actor({ role: Roles.OWNER }), TENANT_A, Permissions.BILLING_MANAGE)).toBe(true);
    expect(can(actor({ role: Roles.ADMIN }), TENANT_A, Permissions.BILLING_MANAGE)).toBe(false);
    expect(can(actor({ role: Roles.ASSISTANT }), TENANT_A, Permissions.BILLING_MANAGE)).toBe(false);
    expect(can(actor({ role: Roles.PROVIDER }), TENANT_A, Permissions.BILLING_MANAGE)).toBe(false);
  });

  it("gives tenant settings only to the owner", () => {
    expect(can(actor({ role: Roles.OWNER }), TENANT_A, Permissions.TENANT_MANAGE)).toBe(true);
    expect(can(actor({ role: Roles.ADMIN }), TENANT_A, Permissions.TENANT_MANAGE)).toBe(false);
  });

  it("gives an assistant delegated reach, never universal reach (PRD §6.3)", () => {
    const assistant = actor({ role: Roles.ASSISTANT });

    // Held the `:all` pair until 2026-08-17. Delegation replaced it, so the
    // front desk reaches the diaries it was handed and no others
    // (docs/phase-3-4-diary-delegation.md §2.1).
    expect(can(assistant, TENANT_A, Permissions.BOOKING_MANAGE_DELEGATED)).toBe(true);
    expect(can(assistant, TENANT_A, Permissions.BOOKING_READ_DELEGATED)).toBe(true);
    expect(can(assistant, TENANT_A, Permissions.AVAILABILITY_MANAGE_DELEGATED)).toBe(true);

    expect(can(assistant, TENANT_A, Permissions.BOOKING_MANAGE_ALL)).toBe(false);
    expect(can(assistant, TENANT_A, Permissions.BOOKING_READ_ALL)).toBe(false);
    expect(can(assistant, TENANT_A, Permissions.SERVICE_MANAGE)).toBe(false);
    expect(can(assistant, TENANT_A, Permissions.PROVIDER_MANAGE)).toBe(false);
    expect(can(assistant, TENANT_A, Permissions.AVAILABILITY_MANAGE_ALL)).toBe(false);
  });

  it("gives a customer no staff permission at all", () => {
    const customer = actor({ role: Roles.CUSTOMER });
    for (const permission of Object.values(Permissions)) {
      expect(can(customer, TENANT_A, permission)).toBe(false);
    }
  });

  it("lets a platform admin through, even with no membership", () => {
    const operator = actor({ noMembership: true, isPlatformAdmin: true });
    expect(can(operator, TENANT_A, Permissions.TENANT_MANAGE)).toBe(true);
    expect(can(operator, TENANT_B, Permissions.BILLING_MANAGE)).toBe(true);
  });
});

describe("owning a resource — the :own permissions", () => {
  it("lets a provider manage their own availability", () => {
    const provider = actor({ role: Roles.PROVIDER, providerId: PROVIDER_SELF });
    expect(canBlockProviderTime(provider, TENANT_A, PROVIDER_SELF)).toBe(true);
  });

  it("stops a provider touching a colleague's availability", () => {
    const provider = actor({ role: Roles.PROVIDER, providerId: PROVIDER_SELF });
    expect(canBlockProviderTime(provider, TENANT_A, PROVIDER_OTHER)).toBe(false);
  });

  it("lets an admin manage anyone's availability", () => {
    const admin = actor({ role: Roles.ADMIN });
    expect(canBlockProviderTime(admin, TENANT_A, PROVIDER_OTHER)).toBe(true);
  });

  it("refuses a provider whose membership is not linked to a provider record", () => {
    // The state before Epic 2 populates providerId. A `:own` permission with
    // nothing to own must not become a wildcard.
    const unlinked = actor({ role: Roles.PROVIDER });
    expect(canBlockProviderTime(unlinked, TENANT_A, PROVIDER_SELF)).toBe(false);
  });

  it("does not let ownership cross a tenant boundary", () => {
    const provider = actor({
      role: Roles.PROVIDER,
      tenantId: TENANT_A,
      providerId: PROVIDER_SELF,
    });
    expect(canBlockProviderTime(provider, TENANT_B, PROVIDER_SELF)).toBe(false);
  });

  it("applies the same rule to connecting a calendar", () => {
    // docs/phase-6-google-calendar-part-1.md. A connected calendar *is* an
    // availability decision made through a third party, so it inherits the
    // availability shape rather than inventing a third one.
    const provider = actor({ role: Roles.PROVIDER, providerId: PROVIDER_SELF });
    const admin = actor({ role: Roles.ADMIN });
    const assistant = actor({ role: Roles.ASSISTANT });

    expect(canManageIntegration(provider, TENANT_A, PROVIDER_SELF)).toBe(true);
    expect(canManageIntegration(provider, TENANT_A, PROVIDER_OTHER)).toBe(false);
    expect(canManageIntegration(admin, TENANT_A, PROVIDER_OTHER)).toBe(true);

    // The front desk manages everyone's bookings and no settings (PRD §6.3).
    // Attaching a Google account is a setting.
    expect(canManageIntegration(assistant, TENANT_A, PROVIDER_SELF)).toBe(false);

    // A `:own` permission with nothing to own is not a wildcard.
    expect(canManageIntegration(actor({ role: Roles.PROVIDER }), TENANT_A, PROVIDER_SELF)).toBe(
      false,
    );

    // And ownership stops at the tenant boundary.
    expect(canManageIntegration(provider, TENANT_B, PROVIDER_SELF)).toBe(false);
  });

  it("applies the same rule to reading and managing bookings", () => {
    const provider = actor({ role: Roles.PROVIDER, providerId: PROVIDER_SELF });

    expect(canReadProviderBookings(provider, TENANT_A, PROVIDER_SELF)).toBe(true);
    expect(canReadProviderBookings(provider, TENANT_A, PROVIDER_OTHER)).toBe(false);
    expect(canManageProviderBookings(provider, TENANT_A, PROVIDER_SELF)).toBe(true);
    expect(canManageProviderBookings(provider, TENANT_A, PROVIDER_OTHER)).toBe(false);

    // An assistant reaches nothing until somebody hands them a diary, and then
    // only that one.
    const ungranted = actor({ role: Roles.ASSISTANT });
    expect(canReadProviderBookings(ungranted, TENANT_A, PROVIDER_OTHER)).toBe(false);

    const granted = actor({
      role: Roles.ASSISTANT,
      delegated: grantOf("BOOKINGS", PROVIDER_OTHER),
    });
    expect(canReadProviderBookings(granted, TENANT_A, PROVIDER_OTHER)).toBe(true);
    expect(canReadProviderBookings(granted, TENANT_A, PROVIDER_SELF)).toBe(false);
  });
});

describe("canChangeMemberRole", () => {
  it("refuses self-modification, even for an owner", () => {
    const owner = actor({ role: Roles.OWNER });
    // membership_1 is the actor's own membership.
    expect(canChangeMemberRole(owner, TENANT_A, "membership_1")).toBe(false);
  });

  it("allows an owner to change someone else's role", () => {
    const owner = actor({ role: Roles.OWNER });
    expect(canChangeMemberRole(owner, TENANT_A, "membership_2")).toBe(true);
  });

  it("refuses an assistant, who has no member-management permission", () => {
    const assistant = actor({ role: Roles.ASSISTANT });
    expect(canChangeMemberRole(assistant, TENANT_A, "membership_2")).toBe(false);
  });
});

describe("tenant lifecycle", () => {
  it("accepts writes only while trial or active", () => {
    expect(tenantAcceptsWrites(TenantStatuses.TRIAL)).toBe(true);
    expect(tenantAcceptsWrites(TenantStatuses.ACTIVE)).toBe(true);
    expect(tenantAcceptsWrites(TenantStatuses.SUSPENDED)).toBe(false);
    expect(tenantAcceptsWrites(TenantStatuses.CLOSED)).toBe(false);
  });

  it("keeps a suspended tenant readable so people can still see their data", () => {
    expect(tenantIsReadable(TenantStatuses.SUSPENDED)).toBe(true);
    expect(tenantIsReadable(TenantStatuses.CLOSED)).toBe(false);
  });
});

describe("role table invariants", () => {
  it("never lets a role be invited that cannot be held", () => {
    for (const role of INVITABLE_ROLES) {
      expect(ALL_ROLES).toContain(role);
    }
  });

  it("excludes CUSTOMER from invitable roles — customers arrive by booking", () => {
    expect(INVITABLE_ROLES).not.toContain(Roles.CUSTOMER);
  });

  it("gives every role an entry, so a new role cannot silently inherit nothing", () => {
    for (const role of ALL_ROLES) {
      expect(ROLE_PERMISSIONS[role], `${role} has no permission entry`).toBeDefined();
    }
  });

  it("keeps the owner's permissions a superset of the admin's", () => {
    // Anything an admin can do, an owner can do. If this ever fails, one of the
    // two lists has drifted.
    for (const permission of ROLE_PERMISSIONS[Roles.ADMIN]) {
      expect(ROLE_PERMISSIONS[Roles.OWNER]).toContain(permission);
    }
  });
});

describe("separation of duties — an operator is not a customer", () => {
  it("lets an ordinary user hold a membership", () => {
    expect(canHoldTenantMembership({ isPlatformAdmin: false })).toBe(true);
  });

  it("refuses a platform admin a membership", () => {
    // Not a privilege they are missing: `can()` already returns true for them
    // in every tenant, so a membership grants nothing and only makes their
    // audit trail ambiguous.
    expect(canHoldTenantMembership({ isPlatformAdmin: true })).toBe(false);
  });

  it("lets a user with no memberships become a platform admin", () => {
    expect(canBecomePlatformAdmin({ membershipCount: 0 })).toBe(true);
  });

  it("refuses to promote a user who belongs to a tenant", () => {
    expect(canBecomePlatformAdmin({ membershipCount: 1 })).toBe(false);
    expect(canBecomePlatformAdmin({ membershipCount: 9 })).toBe(false);
  });

  it("is symmetric: neither order of operations reaches the forbidden state", () => {
    // The state to prevent is (isPlatformAdmin && membershipCount > 0). Guard
    // only one side and it is reachable by doing the two steps the other way
    // round, which is how one-way guards are usually defeated.
    const grantThenJoin = canHoldTenantMembership({ isPlatformAdmin: true });
    const joinThenGrant = canBecomePlatformAdmin({ membershipCount: 1 });

    expect(grantThenJoin).toBe(false);
    expect(joinThenGrant).toBe(false);
  });
});

describe("the activation gate — PENDING_SUBSCRIPTION", () => {
  it("accepts no writes", () => {
    // phase-9 §2.4. An organization that has not paid cannot be configured.
    expect(tenantAcceptsWrites(TenantStatuses.PENDING_SUBSCRIPTION)).toBe(false);
  });

  it("is still readable", () => {
    // The owner has to be able to sign in and see the organization — that is
    // where the subscribe action lives. An organization nobody can look at
    // cannot be paid for, and would expire while its owner tried.
    expect(tenantIsReadable(TenantStatuses.PENDING_SUBSCRIPTION)).toBe(true);
  });

  it("keeps the write gate an allow-list", () => {
    // Inverting this into `!== SUSPENDED` would silently un-gate every status
    // added afterwards. Asserting the whole table makes that a failing test.
    const writable = Object.values(TenantStatuses).filter(tenantAcceptsWrites);
    expect(writable.sort()).toEqual([TenantStatuses.ACTIVE, TenantStatuses.TRIAL].sort());
  });
});

const BOOKING_SCOPE = {
  all: Permissions.BOOKING_READ_ALL,
  own: Permissions.BOOKING_READ_OWN,
  delegated: Permissions.BOOKING_READ_DELEGATED,
};

/**
 * Diary delegation. docs/phase-3-4-diary-delegation.md.
 *
 * A third answer beside `:all` and `:own`, and the one with the most ways to go
 * wrong: it is a *set* rather than a single id, it hangs off a membership whose
 * tenant must match, and it must never reach a rule it was not given a key for.
 */
describe("delegated diaries", () => {
  it("reaches the granted diary and no other", () => {
    const assistant = actor({
      role: Roles.ASSISTANT,
      delegated: grantOf("BOOKINGS", PROVIDER_SELF),
    });

    expect(canReadProviderBookings(assistant, TENANT_A, PROVIDER_SELF)).toBe(true);
    expect(canManageProviderBookings(assistant, TENANT_A, PROVIDER_SELF)).toBe(true);
    expect(canReadProviderBookings(assistant, TENANT_A, PROVIDER_OTHER)).toBe(false);
    expect(canManageProviderBookings(assistant, TENANT_A, PROVIDER_OTHER)).toBe(false);
  });

  it("keeps the two scopes apart in both directions", () => {
    // The whole reason scopes are selectable: handing over the diary must not
    // hand over the appointments, and the other way round.
    const bookingsOnly = actor({
      role: Roles.ASSISTANT,
      delegated: grantOf("BOOKINGS", PROVIDER_SELF),
    });
    expect(canManageProviderBookings(bookingsOnly, TENANT_A, PROVIDER_SELF)).toBe(true);
    expect(canBlockProviderTime(bookingsOnly, TENANT_A, PROVIDER_SELF)).toBe(false);

    const availabilityOnly = actor({
      role: Roles.ASSISTANT,
      delegated: grantOf("AVAILABILITY", PROVIDER_SELF),
    });
    expect(canBlockProviderTime(availabilityOnly, TENANT_A, PROVIDER_SELF)).toBe(true);
    expect(canReadProviderBookings(availabilityOnly, TENANT_A, PROVIDER_SELF)).toBe(false);
    expect(canManageProviderBookings(availabilityOnly, TENANT_A, PROVIDER_SELF)).toBe(false);
  });

  it("never reaches a rule that was given no delegated key", () => {
    // canManageIntegration deliberately has no delegated branch: a connected
    // calendar is a setting, not a day's work. No scope can reach it, and this
    // is the assertion pinning that.
    const both = actor({
      role: Roles.ASSISTANT,
      delegated: {
        ...grantOf("AVAILABILITY", PROVIDER_SELF),
        ...grantOf("BOOKINGS", PROVIDER_SELF),
      },
    });

    expect(canManageIntegration(both, TENANT_A, PROVIDER_SELF)).toBe(false);
  });

  it("decides nothing in another tenant", () => {
    // The set hangs off the membership, which carries its own tenant id, so
    // there is no representable state in which one tenant's grants answer for
    // another tenant's resource. Asserted anyway: this is the property the
    // placement exists to produce.
    const assistant = actor({
      role: Roles.ASSISTANT,
      tenantId: TENANT_A,
      delegated: {
        ...grantOf("AVAILABILITY", PROVIDER_SELF),
        ...grantOf("BOOKINGS", PROVIDER_SELF),
      },
    });

    expect(canBlockProviderTime(assistant, TENANT_B, PROVIDER_SELF)).toBe(false);
    expect(canReadProviderBookings(assistant, TENANT_B, PROVIDER_SELF)).toBe(false);
    expect(providerIdsInScope(assistant, TENANT_B, BOOKING_SCOPE)).toEqual({
      kind: "some",
      providerIds: [],
    });
  });

  it("confers nothing once the role stops receiving delegations", () => {
    // The rows survive a role change and go inert rather than being deleted
    // (§2.8). Deleting them would let an administrator's temporary role change
    // destroy configuration belonging to the provider, who was never asked.
    // Pinned here so reversing that is a failing test, not a quiet change.
    const promoted = actor({
      role: Roles.PROVIDER,
      delegated: grantOf("BOOKINGS", PROVIDER_OTHER),
    });

    expect(canReadProviderBookings(promoted, TENANT_A, PROVIDER_OTHER)).toBe(false);
  });

  it("is inert on a suspended membership", () => {
    const suspended = actor({
      role: Roles.ASSISTANT,
      status: MembershipStatuses.SUSPENDED,
      delegated: grantOf("BOOKINGS", PROVIDER_SELF),
    });

    expect(canReadProviderBookings(suspended, TENANT_A, PROVIDER_SELF)).toBe(false);
  });
});

describe("canDelegateProviderDiary", () => {
  it("refuses a delegate, so a diary cannot be handed on", () => {
    // §2.3, and the single most important assertion in the feature. With a
    // delegated branch here, the set of people who can reach a provider's
    // calendar would grow without the provider, the owner or the audit log
    // naming anybody who decided it.
    const delegate = actor({
      role: Roles.ASSISTANT,
      delegated: grantOf("AVAILABILITY", PROVIDER_SELF),
    });

    expect(canBlockProviderTime(delegate, TENANT_A, PROVIDER_SELF)).toBe(true);
    expect(canDelegateProviderDiary(delegate, TENANT_A, PROVIDER_SELF)).toBe(false);
  });

  it("allows a provider over their own diary and nobody else's", () => {
    const provider = actor({ role: Roles.PROVIDER, providerId: PROVIDER_SELF });

    expect(canDelegateProviderDiary(provider, TENANT_A, PROVIDER_SELF)).toBe(true);
    expect(canDelegateProviderDiary(provider, TENANT_A, PROVIDER_OTHER)).toBe(false);
  });

  it("refuses a provider whose membership names no diary", () => {
    const unlinked = actor({ role: Roles.PROVIDER });
    expect(canDelegateProviderDiary(unlinked, TENANT_A, PROVIDER_SELF)).toBe(false);
  });

  it("allows an owner or admin over anyone's diary, and only in their tenant", () => {
    for (const role of [Roles.OWNER, Roles.ADMIN]) {
      const administrator = actor({ role });
      expect(canDelegateProviderDiary(administrator, TENANT_A, PROVIDER_OTHER)).toBe(true);
      expect(canDelegateProviderDiary(administrator, TENANT_B, PROVIDER_OTHER)).toBe(false);
    }
  });
});

describe("providerIdsInScope", () => {
  it("returns `all` for a role holding the :all variant", () => {
    expect(providerIdsInScope(actor({ role: Roles.ADMIN }), TENANT_A, BOOKING_SCOPE)).toEqual({
      kind: "all",
    });
  });

  it("returns the caller's own diary for a linked provider", () => {
    const provider = actor({ role: Roles.PROVIDER, providerId: PROVIDER_SELF });
    expect(providerIdsInScope(provider, TENANT_A, BOOKING_SCOPE)).toEqual({
      kind: "some",
      providerIds: [PROVIDER_SELF],
    });
  });

  it("returns an empty set — not `all` — when the caller reaches nothing", () => {
    // The failure this return type exists to prevent. A caller that reads an
    // empty set as "no filter" lists the whole tenant, which is rule 10's
    // "an unpopulated field must never widen access" (§4.3).
    const unlinked = actor({ role: Roles.PROVIDER });
    expect(providerIdsInScope(unlinked, TENANT_A, BOOKING_SCOPE)).toEqual({
      kind: "some",
      providerIds: [],
    });

    const ungranted = actor({ role: Roles.ASSISTANT });
    expect(providerIdsInScope(ungranted, TENANT_A, BOOKING_SCOPE)).toEqual({
      kind: "some",
      providerIds: [],
    });
  });

  it("unions every granted diary", () => {
    const assistant = actor({
      role: Roles.ASSISTANT,
      delegated: grantOf("BOOKINGS", PROVIDER_SELF, PROVIDER_OTHER),
    });

    const scope = providerIdsInScope(assistant, TENANT_A, BOOKING_SCOPE);
    expect(scope.kind).toBe("some");
    expect(scope.kind === "some" ? [...scope.providerIds].sort() : []).toEqual(
      [PROVIDER_SELF, PROVIDER_OTHER].sort(),
    );
  });

  it("does not repeat a diary that is both the caller's own and granted", () => {
    // Reachable: nothing constrains a membership that names a provider from
    // also holding a grant on it.
    const provider = actor({
      role: Roles.PROVIDER,
      providerId: PROVIDER_SELF,
      delegated: grantOf("BOOKINGS", PROVIDER_SELF),
    });

    expect(providerIdsInScope(provider, TENANT_A, BOOKING_SCOPE)).toEqual({
      kind: "some",
      providerIds: [PROVIDER_SELF],
    });
  });
});

describe("delegatedProviderIdsFrom", () => {
  it("expands one BOOKINGS grant into both booking permissions", () => {
    const delegated = delegatedProviderIdsFrom([
      { providerId: PROVIDER_SELF, scopes: ["BOOKINGS"] },
    ]);

    expect(delegated[Permissions.BOOKING_READ_DELEGATED]).toEqual([PROVIDER_SELF]);
    expect(delegated[Permissions.BOOKING_MANAGE_DELEGATED]).toEqual([PROVIDER_SELF]);
    expect(delegated[Permissions.AVAILABILITY_MANAGE_DELEGATED]).toBeUndefined();
  });

  it("merges grants across diaries", () => {
    const delegated = delegatedProviderIdsFrom([
      { providerId: PROVIDER_SELF, scopes: ["BOOKINGS"] },
      { providerId: PROVIDER_OTHER, scopes: ["BOOKINGS", "AVAILABILITY"] },
    ]);

    expect([...(delegated[Permissions.BOOKING_READ_DELEGATED] ?? [])].sort()).toEqual(
      [PROVIDER_SELF, PROVIDER_OTHER].sort(),
    );
    expect(delegated[Permissions.AVAILABILITY_MANAGE_DELEGATED]).toEqual([PROVIDER_OTHER]);
  });

  it("ignores a scope it does not recognise rather than throwing", () => {
    // A database enum value newer than this build must fail closed, not 500
    // every request that touches it.
    const delegated = delegatedProviderIdsFrom([
      { providerId: PROVIDER_SELF, scopes: ["BILLING_SOMEDAY", "BOOKINGS"] },
    ]);

    expect(delegated[Permissions.BOOKING_READ_DELEGATED]).toEqual([PROVIDER_SELF]);
    expect(Object.keys(delegated)).toHaveLength(2);
  });

  it("produces nothing from no grants", () => {
    expect(delegatedProviderIdsFrom([])).toEqual({});
  });
});

describe("delegation table invariants", () => {
  it("gives no role both the :all and the :delegated variant of a pair", () => {
    // A role holding both makes a branch of canForProvider that can never be
    // reached — dead weight in the one table nobody may misread (§2.1).
    const pairs = [
      [Permissions.AVAILABILITY_MANAGE_ALL, Permissions.AVAILABILITY_MANAGE_DELEGATED],
      [Permissions.BOOKING_READ_ALL, Permissions.BOOKING_READ_DELEGATED],
      [Permissions.BOOKING_MANAGE_ALL, Permissions.BOOKING_MANAGE_DELEGATED],
    ] as const;

    for (const role of ALL_ROLES) {
      for (const [all, delegated] of pairs) {
        const held = ROLE_PERMISSIONS[role];
        expect(
          held.includes(all) && held.includes(delegated),
          `${role} holds both ${all} and ${delegated}`,
        ).toBe(false);
      }
    }
  });

  it("maps every scope to at least one permission that exists", () => {
    const known = new Set<string>(Object.values(Permissions));

    for (const scope of ALL_DELEGATION_SCOPES) {
      const permissions = DELEGATION_SCOPE_PERMISSIONS[scope];
      expect(permissions.length).toBeGreaterThan(0);
      for (const permission of permissions) expect(known.has(permission)).toBe(true);
    }
  });

  it("makes exactly the front desk able to receive a diary", () => {
    // Asserted through the function rather than against a role list, because
    // the function is what the plugin and the service both call (§2.11).
    expect(roleCanReceiveDelegation(Roles.ASSISTANT)).toBe(true);

    for (const role of [Roles.OWNER, Roles.ADMIN, Roles.PROVIDER, Roles.CUSTOMER]) {
      expect(roleCanReceiveDelegation(role), role).toBe(false);
    }
  });

  it("confers only :delegated permissions", () => {
    for (const permission of DELEGATED_PERMISSIONS) {
      expect(permission.endsWith(":delegated")).toBe(true);
    }
  });
});
