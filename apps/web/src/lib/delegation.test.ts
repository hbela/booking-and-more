import { describe, expect, it } from "vitest";
import type { MeResponse } from "./api-client";
import { diaryScopeFor, hasPersonalDiary } from "./delegation";

/**
 * The three-way "which diaries may I work on" answer, tested without a DOM.
 *
 * Pure for the same reason `member-diary.ts` next door is: this decides what
 * the availability and bookings screens render, and getting it wrong either
 * offers a diary the API will refuse or hides one the caller owns.
 */
function me(overrides: {
  permissions?: string[];
  providerId?: string | null;
  delegations?: MeResponse["delegations"];
}): MeResponse {
  return {
    user: { id: "user_1", name: "Réka", email: "reka@example.test", isPlatformAdmin: false },
    tenant: null,
    membership: {
      id: "membership_1",
      role: "ASSISTANT",
      providerId: overrides.providerId ?? null,
    },
    permissions: overrides.permissions ?? [],
    features: { assistant: false },
    delegations: overrides.delegations ?? [],
  };
}

describe("diaryScopeFor", () => {
  it("reports every diary for a caller holding the :all permission", () => {
    const scope = diaryScopeFor(
      me({ permissions: ["availability:manage:all"] }),
      "availability:manage:all",
      "AVAILABILITY",
    );

    expect(scope.everyDiary).toBe(true);
  });

  it("reports the caller's own diary", () => {
    const scope = diaryScopeFor(
      me({ providerId: "provider_1" }),
      "availability:manage:all",
      "AVAILABILITY",
    );

    expect(scope).toEqual({
      everyDiary: false,
      providerIds: ["provider_1"],
      ownProviderId: "provider_1",
    });
  });

  it("reports only the diaries granted for that scope", () => {
    const scope = diaryScopeFor(
      me({
        delegations: [
          { providerId: "provider_1", scopes: ["BOOKINGS"] },
          { providerId: "provider_2", scopes: ["AVAILABILITY", "BOOKINGS"] },
        ],
      }),
      "availability:manage:all",
      "AVAILABILITY",
    );

    // provider_1 was granted bookings only, so it is not an availability diary.
    expect(scope.providerIds).toEqual(["provider_2"]);
  });

  it("unions the caller's own diary with the granted ones, without repeating", () => {
    const scope = diaryScopeFor(
      me({
        providerId: "provider_1",
        delegations: [
          { providerId: "provider_1", scopes: ["AVAILABILITY"] },
          { providerId: "provider_2", scopes: ["AVAILABILITY"] },
        ],
      }),
      "availability:manage:all",
      "AVAILABILITY",
    );

    expect([...scope.providerIds].sort()).toEqual(["provider_1", "provider_2"]);
  });

  it("reports nothing, not everything, for a member with no reach", () => {
    // The distinction the screens depend on: an empty list renders an empty
    // state, and must never be mistaken for "no filter needed".
    const scope = diaryScopeFor(me({}), "availability:manage:all", "AVAILABILITY");

    expect(scope.everyDiary).toBe(false);
    expect(scope.providerIds).toEqual([]);
  });

  it("survives a missing /v1/me", () => {
    const scope = diaryScopeFor(null, "availability:manage:all", "AVAILABILITY");
    expect(scope).toEqual({ everyDiary: false, providerIds: [], ownProviderId: null });
  });
});

describe("hasPersonalDiary", () => {
  it("is true for a member linked to a diary", () => {
    expect(hasPersonalDiary(me({ providerId: "provider_1" }), "AVAILABILITY")).toBe(true);
  });

  it("is true for a member granted one", () => {
    expect(
      hasPersonalDiary(
        me({ delegations: [{ providerId: "provider_1", scopes: ["AVAILABILITY"] }] }),
        "AVAILABILITY",
      ),
    ).toBe(true);
  });

  it("is false when the only grant is for another scope", () => {
    expect(
      hasPersonalDiary(
        me({ delegations: [{ providerId: "provider_1", scopes: ["BOOKINGS"] }] }),
        "AVAILABILITY",
      ),
    ).toBe(false);
  });

  it("is false for an administrator, who has no diary of their own", () => {
    // Load-bearing, and the easiest thing in this file to "fix" by accident.
    // It decides the top-level Availability nav item, and phase-2-3 §2.7 is
    // explicit that availability belongs to a provider rather than to the
    // organization: an owner reaches one diary at a time from the Providers row.
    expect(hasPersonalDiary(me({ permissions: ["availability:manage:all"] }), "AVAILABILITY")).toBe(
      false,
    );
  });
});
