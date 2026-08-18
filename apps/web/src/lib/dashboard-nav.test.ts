import { describe, expect, it } from "vitest";
import type { MeResponse } from "@/lib/api-client";
import { navFor } from "./dashboard-nav";

/**
 * Which navigation items each role actually gets.
 *
 * This exists because the nav is where diary delegation would most easily ship
 * invisible or broken, in both directions: omitting `booking:read:delegated`
 * removes Bookings from every front desk, and gating on it alone puts a link in
 * front of an assistant whose every click 403s. Neither is type-checked —
 * `apps/web` does not depend on `@bam/auth` and the permissions are strings
 * (docs/phase-3-4-diary-delegation.md §6.3).
 *
 * `navFor` is pure, so this needs no DOM and no query client.
 */
function me(overrides: {
  permissions?: string[];
  providerId?: string | null;
  delegations?: MeResponse["delegations"];
}): MeResponse {
  return {
    user: { id: "user_1", name: "Test", email: "test@example.test", isPlatformAdmin: false },
    tenant: null,
    membership: { id: "m_1", role: "ASSISTANT", providerId: overrides.providerId ?? null },
    permissions: overrides.permissions ?? [],
    delegations: overrides.delegations ?? [],
  };
}

const keysFor = (response: MeResponse | null): string[] => navFor(response).map((item) => item.key);

// The real tables, so a change to @bam/auth that is not mirrored here shows up
// as a surprising nav rather than as a passing test about nothing.
const OWNER = [
  "tenant:manage",
  "tenant:read",
  "billing:manage",
  "member:manage",
  "member:read",
  "provider:manage",
  "service:manage",
  "location:manage",
  "availability:manage:all",
  "availability:manage:own",
  "booking:read:all",
  "booking:read:own",
  "booking:manage:all",
  "booking:manage:own",
];

const ASSISTANT = [
  "tenant:read",
  "member:read",
  "availability:manage:delegated",
  "booking:read:delegated",
  "booking:manage:delegated",
];

const PROVIDER = [
  "tenant:read",
  "member:read",
  "availability:manage:own",
  "booking:read:own",
  "booking:manage:own",
];

describe("navFor", () => {
  it("gives an owner everything but the top-level availability item", () => {
    // Availability belongs to a provider, not to the organization: an owner
    // reaches one diary at a time from the Providers row (phase-2-3 §2.7).
    expect(keysFor(me({ permissions: OWNER }))).toEqual([
      "overview",
      "subscription",
      "bookings",
      "services",
      "locations",
      "providers",
    ]);
  });

  it("keeps Bookings ahead of the catalogue, whoever is looking", () => {
    // Order comes from one declared array, so this holds regardless of which
    // items the two gates removed for a given caller.
    const owner = keysFor(me({ permissions: OWNER }));
    expect(owner.indexOf("bookings")).toBeLessThan(owner.indexOf("services"));
    expect(owner.indexOf("subscription")).toBeLessThan(owner.indexOf("bookings"));
  });

  it("shows an ungranted assistant no Bookings item", () => {
    // The defect this test was written for. They hold `booking:read:delegated`
    // from the moment they join, and the list 403s until a provider grants them
    // a diary.
    expect(keysFor(me({ permissions: ASSISTANT }))).toEqual(["overview"]);
  });

  it("gives a granted assistant exactly what their grant covers", () => {
    const bookingsOnly = me({
      permissions: ASSISTANT,
      delegations: [{ providerId: "p_1", scopes: ["BOOKINGS"] }],
    });
    expect(keysFor(bookingsOnly)).toEqual(["overview", "bookings"]);

    const availabilityOnly = me({
      permissions: ASSISTANT,
      delegations: [{ providerId: "p_1", scopes: ["AVAILABILITY"] }],
    });
    expect(keysFor(availabilityOnly)).toEqual(["overview", "availability"]);

    const both = me({
      permissions: ASSISTANT,
      delegations: [{ providerId: "p_1", scopes: ["AVAILABILITY", "BOOKINGS"] }],
    });
    expect(keysFor(both)).toEqual(["overview", "bookings", "availability"]);
  });

  it("gives a linked provider Overview, Bookings and Availability", () => {
    // The table phase-9-provider-onboarding §2.9 states.
    expect(keysFor(me({ permissions: PROVIDER, providerId: "p_1" }))).toEqual([
      "overview",
      "bookings",
      "availability",
    ]);
  });

  it("shows a provider whose membership names no diary neither of them", () => {
    // `booking:read:own` and `availability:manage:own` match nothing without a
    // linked diary, so both screens 403.
    expect(keysFor(me({ permissions: PROVIDER }))).toEqual(["overview"]);
  });

  it("survives a caller with no /v1/me at all", () => {
    expect(keysFor(null)).toEqual(["overview"]);
  });
});
