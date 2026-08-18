import { describe, expect, it } from "vitest";
import { buildContentSecurityPolicy } from "./lib/security-headers.js";

describe("web content security policy", () => {
  it("uses a per-request nonce and blocks framing and plugins", () => {
    const csp = buildContentSecurityPolicy("nonce-for-test", true);

    expect(csp).toContain("script-src 'self' 'nonce-nonce-for-test' 'strict-dynamic'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("upgrade-insecure-requests");
    expect(csp).not.toContain("'unsafe-eval'");
  });

  it("permits eval only for the development toolchain", () => {
    expect(buildContentSecurityPolicy("dev", false)).toContain("'unsafe-eval'");
  });

});
