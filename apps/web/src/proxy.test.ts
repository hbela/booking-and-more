import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { proxy } from "./proxy.js";
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

describe("invitation language", () => {
  it.each(["wellness", "medicare"])("keeps the language of %s staff entry links", (slug) => {
    const hu = proxy(
      new NextRequest(`http://localhost:3000/${slug}/sign-in`, {
        headers: { "accept-language": "en", cookie: "NEXT_LOCALE=en" },
      }),
    );
    expect(hu.headers.get("location")).toBeNull();
    expect(hu.headers.get("x-middleware-rewrite")).toBe(`http://localhost:3000/hu/${slug}/sign-in`);
    const en = proxy(
      new NextRequest(`http://localhost:3000/en/${slug}/sign-in`, {
        headers: { "accept-language": "hu", cookie: "NEXT_LOCALE=hu" },
      }),
    );
    expect(en.headers.get("location")).toBeNull();
    expect(en.headers.get("x-middleware-request-x-next-intl-locale")).toBe("en");
  });

  it.each([undefined, "en"])(
    "keeps Hungarian invitations in Hungarian with an English browser and cookie %s",
    (cookie) => {
      const headers = new Headers({ "accept-language": "en-US,en;q=0.9" });
      if (cookie) headers.set("cookie", `NEXT_LOCALE=${cookie}`);
      const response = proxy(
        new NextRequest("http://localhost:3000/invitations/token", { headers }),
      );

      expect(response.headers.get("location")).toBeNull();
      expect(response.headers.get("x-middleware-rewrite")).toBe(
        "http://localhost:3000/hu/invitations/token",
      );
      expect(response.cookies.get("NEXT_LOCALE")?.value).toBe("hu");

      const dashboard = proxy(
        new NextRequest("http://localhost:3000/dashboard", {
          headers: {
            "accept-language": "en-US,en;q=0.9",
            cookie: `NEXT_LOCALE=${response.cookies.get("NEXT_LOCALE")?.value}`,
          },
        }),
      );
      expect(dashboard.headers.get("location")).toBeNull();
      expect(dashboard.headers.get("x-middleware-rewrite")).toBe(
        "http://localhost:3000/hu/dashboard",
      );
    },
  );

  it("keeps English invitations in English for a Hungarian browser", () => {
    const response = proxy(
      new NextRequest("http://localhost:3000/en/invitations/token", {
        headers: { "accept-language": "hu", cookie: "NEXT_LOCALE=hu" },
      }),
    );
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("x-middleware-next")).toBe("1");
    expect(response.headers.get("x-middleware-request-x-next-intl-locale")).toBe("en");
    expect(response.cookies.get("NEXT_LOCALE")?.value).toBe("en");
  });

  it("still lets the dashboard follow a language switch", () => {
    const response = proxy(
      new NextRequest("http://localhost:3000/dashboard", {
        headers: { "accept-language": "hu", cookie: "NEXT_LOCALE=en" },
      }),
    );
    expect(response.headers.get("location")).toBe("http://localhost:3000/en/dashboard");
  });
});
