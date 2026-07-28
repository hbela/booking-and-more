import { describe, expect, it } from "vitest";
import {
  ALL_ROLES,
  INVITABLE_ROLES,
  Permissions,
  ROLE_PERMISSIONS,
  Roles,
  type Role,
} from "./roles.js";
import {
  MembershipStatuses,
  TenantStatuses,
  type Actor,
  can,
  canBlockProviderTime,
  canChangeMemberRole,
  canManageProviderBookings,
  canReadProviderBookings,
  isMemberOf,
  tenantAcceptsWrites,
  tenantIsReadable,
} from "./policy.js";

const TENANT_A = "tenant_a";
const TENANT_B = "tenant_b";

function actor(overrides: {
  role?: Role;
  tenantId?: string;
  status?: (typeof MembershipStatuses)[keyof typeof MembershipStatuses];
  providerId?: string;
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
    },
  };
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

  it("lets an assistant manage bookings but not services or providers (PRD §6.3)", () => {
    const assistant = actor({ role: Roles.ASSISTANT });

    expect(can(assistant, TENANT_A, Permissions.BOOKING_MANAGE_ALL)).toBe(true);
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
  const PROVIDER_SELF = "provider_self";
  const PROVIDER_OTHER = "provider_other";

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

  it("applies the same rule to reading and managing bookings", () => {
    const provider = actor({ role: Roles.PROVIDER, providerId: PROVIDER_SELF });

    expect(canReadProviderBookings(provider, TENANT_A, PROVIDER_SELF)).toBe(true);
    expect(canReadProviderBookings(provider, TENANT_A, PROVIDER_OTHER)).toBe(false);
    expect(canManageProviderBookings(provider, TENANT_A, PROVIDER_SELF)).toBe(true);
    expect(canManageProviderBookings(provider, TENANT_A, PROVIDER_OTHER)).toBe(false);

    // An assistant holds the :all variant, so ownership is irrelevant.
    const assistant = actor({ role: Roles.ASSISTANT });
    expect(canReadProviderBookings(assistant, TENANT_A, PROVIDER_OTHER)).toBe(true);
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
