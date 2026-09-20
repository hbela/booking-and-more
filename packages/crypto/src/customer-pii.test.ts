import { describe, expect, it } from "vitest";
import { createCustomerPii } from "./customer-pii.js";

describe("customer PII", () => {
  const pii = createCustomerPii("11".repeat(32), "22".repeat(32));
  it("authenticates randomized envelopes, including empty strings", () => {
    for (const value of ["", "Ágnes", "person@example.com"]) {
      const sealed = pii.seal(value);
      expect(pii.open(sealed)).toBe(value);
      expect(pii.seal(value)).not.toBe(sealed);
      expect(() => createCustomerPii("33".repeat(32), "22".repeat(32)).open(sealed)).toThrow();
    }
    expect(() => pii.open("plaintext")).toThrow();
    expect(pii.openNullable(null)).toBeNull();
  });
  it("isolates deterministic indexes by tenant and key", () => {
    expect(pii.index("a", "email")).toBe(pii.index("a", "email"));
    expect(pii.index("a", "email")).not.toBe(pii.index("b", "email"));
    expect(pii.index("a", "email")).not.toBe(
      createCustomerPii("11".repeat(32), "33".repeat(32)).index("a", "email"),
    );
    expect(pii.index("a", "")).toBeNull();
    expect(() => createCustomerPii("bad", "22".repeat(32))).toThrow();
    expect(() => createCustomerPii("11".repeat(32), "11".repeat(32))).toThrow();
  });
});
