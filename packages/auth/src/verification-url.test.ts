import { describe, expect, it } from "vitest";
import { verificationUrlForApp } from "./verification-url.js";

const app = "https://app.example.test";
const link = (callback: string): string =>
  `https://api.example.test/v1/auth/verify-email?token=abc&callbackURL=${encodeURIComponent(callback)}`;
const callbackOf = (url: string): string | null => new URL(url).searchParams.get("callbackURL");

describe("verificationUrlForApp", () => {
  it("sends Better Auth's default callback to the dashboard, not the API root", () => {
    expect(callbackOf(verificationUrlForApp(link("/"), app))).toBe(`${app}/dashboard`);
  });

  it("keeps the token and the API origin", () => {
    const url = new URL(verificationUrlForApp(link("/"), app));
    expect(url.origin).toBe("https://api.example.test");
    expect(url.pathname).toBe("/v1/auth/verify-email");
    expect(url.searchParams.get("token")).toBe("abc");
  });

  it("anchors any other relative path on the app", () => {
    expect(callbackOf(verificationUrlForApp(link("/en/dashboard"), app))).toBe(
      `${app}/en/dashboard`,
    );
  });

  it("leaves an absolute callback alone", () => {
    const absolute = link(`${app}/en/dashboard`);
    expect(verificationUrlForApp(absolute, app)).toBe(absolute);
  });

  it("does not treat a scheme-relative callback as a path", () => {
    const relative = link("//evil.example.test");
    expect(verificationUrlForApp(relative, app)).toBe(relative);
  });
});
