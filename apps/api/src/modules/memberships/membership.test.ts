import { describe, expect, it } from "vitest";
import { ALL_ROLES, INVITABLE_ROLES } from "@bam/auth";
import { invitableRoleSchema, roleSchema } from "./membership.schemas.js";

/**
 * The test `membership.routes.ts` has always claimed keeps its role literals in
 * step with `@bam/auth` — and which did not exist until
 * docs/phase-9-provider-onboarding.md §3.1.
 *
 * The literals are spelled out rather than derived because `z.enum(ROLES)` on a
 * `readonly string[]` infers `string`, which type-checks and then lets any
 * string through the handler types. That is a real reason to duplicate, and the
 * price of duplicating is exactly this file: without it, adding a role to
 * `@bam/auth` silently leaves an endpoint that refuses it, and removing one
 * leaves an endpoint that still offers it.
 *
 * No database and no `skipIf`: these are two arrays.
 */
describe("membership role schemas", () => {
  it("spells out exactly the roles @bam/auth defines", () => {
    expect([...roleSchema.options].sort()).toEqual([...ALL_ROLES].sort());
  });

  it("spells out exactly the roles that can be granted by invitation", () => {
    expect([...invitableRoleSchema.options].sort()).toEqual([...INVITABLE_ROLES].sort());
  });

  it("never offers CUSTOMER by invitation", () => {
    // Not implied by the two above — both would still pass if CUSTOMER were
    // added to INVITABLE_ROLES. A customer is not a member of the organization
    // that serves them, and an invitation is the one path that could make one.
    expect(invitableRoleSchema.options).not.toContain("CUSTOMER");
  });
});
