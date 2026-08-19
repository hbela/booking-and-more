import { describe, expect, it } from "vitest";
import { hasNoOrganization } from "./organization-state";

describe("hasNoOrganization", () => {
  it("is true once the list has come back with nothing", () => {
    expect(hasNoOrganization({ settled: true, count: 0 })).toBe(true);
  });

  it("is false when the user belongs to one", () => {
    expect(hasNoOrganization({ settled: true, count: 1 })).toBe(false);
  });

  // The two that the whole function exists for: an empty list is also what a
  // request in flight and a request that failed look like, and neither of them
  // is "you have no organization".
  it("is false while the request is still in flight", () => {
    expect(hasNoOrganization({ settled: false, count: 0 })).toBe(false);
  });

  it("is false when the request failed, rather than claiming there are none", () => {
    // A failure leaves the same empty list a success would; only `settled`
    // separates them. Telling somebody they belong to nothing because the API
    // was down sends them to ask for access they already hold.
    expect(hasNoOrganization({ settled: false, count: 0 })).toBe(false);
  });

  it("does not report a member of several as having none", () => {
    expect(hasNoOrganization({ settled: true, count: 3 })).toBe(false);
  });
});
