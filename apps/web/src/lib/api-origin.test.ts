import { describe, expect, it } from "vitest";
import { parseApiOrigin } from "./api-origin";

describe("production API origin", () => {
  it("requires an HTTPS origin without credentials or URL suffixes", () => {
    for (const value of [
      undefined,
      "api.example.com",
      "http://localhost:3001",
      "https://user:pass@example.com",
      "https://example.com/api",
      "https://example.com?key=value",
    ]) {
      expect(() => parseApiOrigin(value, true)).toThrow("NEXT_PUBLIC_API_BASE_URL");
    }
    expect(parseApiOrigin("https://api.example.com/", true)).toBe("https://api.example.com");
    expect(parseApiOrigin(undefined, false)).toBe("http://localhost:3001");
  });
});
