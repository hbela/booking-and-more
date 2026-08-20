import { describe, expect, it } from "vitest";
import type { Member, Provider } from "./api-client";
import { resolveDiaryState } from "./member-diary";

/**
 * The regression suite for "(archived diary)".
 *
 * A signed-in PROVIDER opened the dashboard and was told their own working
 * diary was archived — because the providers query is enabled only for a
 * members-manager, and the column read the resulting empty list as evidence.
 * None of this needs a DOM, which is the point: the API was answering
 * correctly throughout, so no API test could have caught it.
 */

function provider(id: string, over: Partial<Provider> = {}): Provider {
  return {
    id,
    displayName: id,
    description: null,
    email: null,
    phone: null,
    timezone: "Europe/Budapest",
    languages: ["hu"],
    active: true,
    onlineBookingEnabled: true,
    autoConfirmBookings: false,
    minimumNoticeMinutes: null,
    maximumAdvanceDays: null,
    archivedAt: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...over,
  };
}

function member(over: Partial<Member> = {}): Pick<Member, "role" | "providerId"> {
  return { role: "PROVIDER", providerId: null, ...over };
}

describe("resolveDiaryState", () => {
  it("names the diary when the list holds it", () => {
    expect(
      resolveDiaryState({
        member: member({ providerId: "p1" }),
        providers: [provider("p1", { displayName: "Dr. Kiss Katalin" })],
      }),
    ).toEqual({ kind: "named", displayName: "Dr. Kiss Katalin" });
  });

  it("reports a linked diary as linked, not archived, when the list was never fetched", () => {
    // The reported bug. A PROVIDER holds `member:read` and not `member:manage`,
    // so the providers query never runs and this is what their own row hits.
    expect(resolveDiaryState({ member: member({ providerId: "p1" }), providers: null })).toEqual({
      kind: "linked",
    });
  });

  it("reports archived only when a list we hold is missing the diary", () => {
    expect(
      resolveDiaryState({ member: member({ providerId: "gone" }), providers: [provider("p1")] }),
    ).toEqual({ kind: "archived" });
  });

  it("distinguishes an empty list from an absent one", () => {
    // `[]` is a tenant whose every diary is archived — a real answer. `null` is
    // no answer at all. Collapsing the two is the whole bug.
    expect(resolveDiaryState({ member: member({ providerId: "p1" }), providers: [] })).toEqual({
      kind: "archived",
    });
  });

  it("flags a PROVIDER holding no diary, whoever is looking", () => {
    // The warning that must survive for a non-manager: every `:own` permission
    // this membership holds matches nothing until a diary is linked.
    expect(resolveDiaryState({ member: member(), providers: null })).toEqual({ kind: "missing" });
    expect(resolveDiaryState({ member: member(), providers: [provider("p1")] })).toEqual({
      kind: "missing",
    });
  });

  it("says nothing about an owner or an assistant with no diary", () => {
    for (const role of ["OWNER", "ADMIN", "ASSISTANT"]) {
      expect(resolveDiaryState({ member: member({ role }), providers: [] })).toEqual({
        kind: "none",
      });
    }
  });
});
