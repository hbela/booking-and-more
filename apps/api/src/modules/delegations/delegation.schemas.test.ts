import { describe, expect, it } from "vitest";
import {
  ALL_DELEGATION_SCOPES,
  DELEGATION_SCOPE_PERMISSIONS,
  DELEGATED_PERMISSIONS,
} from "@bam/auth";
import { delegationScopeSchema, delegationScopesSchema } from "./delegation.schemas.js";

/**
 * The same job membership.test.ts does for roles, for delegation scopes.
 *
 * The literals are spelled out rather than derived because `z.enum` on a
 * `readonly string[]` infers `string`, which type-checks and then lets any
 * string through the handler types. The price of duplicating is this file:
 * without it, adding a scope to `@bam/auth` silently leaves an endpoint that
 * refuses it.
 *
 * No database and no `skipIf`: these are arrays and a table.
 */
describe("delegation scope schemas", () => {
  it("spells out exactly the scopes @bam/auth defines", () => {
    expect([...delegationScopeSchema.options].sort()).toEqual([...ALL_DELEGATION_SCOPES].sort());
  });

  it("maps every scope to at least one permission", () => {
    // A scope that confers nothing would be offered on the screen, stored in the
    // database and grant no access — the hardest kind of bug to see, because
    // every layer reports success.
    for (const scope of ALL_DELEGATION_SCOPES) {
      expect(DELEGATION_SCOPE_PERMISSIONS[scope].length).toBeGreaterThan(0);
    }
  });

  it("confers only permissions that end in :delegated", () => {
    // The `:delegated` suffix is what keeps these out of `canForProvider`'s
    // first two branches. A grant that handed out an `:all` permission would
    // silently make every delegate an administrator.
    for (const permission of DELEGATED_PERMISSIONS) {
      expect(permission.endsWith(":delegated")).toBe(true);
    }
  });

  it("refuses an empty scope set, mirroring the database CHECK", () => {
    expect(delegationScopesSchema.safeParse([]).success).toBe(false);
  });

  it("refuses a repeated scope", () => {
    expect(delegationScopesSchema.safeParse(["BOOKINGS", "BOOKINGS"]).success).toBe(false);
  });

  it("accepts one scope and both", () => {
    expect(delegationScopesSchema.safeParse(["BOOKINGS"]).success).toBe(true);
    expect(delegationScopesSchema.safeParse(["AVAILABILITY", "BOOKINGS"]).success).toBe(true);
  });
});
