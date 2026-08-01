import { describe, expect, it } from "vitest";

import { normalizeLocale, resolveLocale } from "./locale.js";
import { FALLBACK_LOCALE } from "./types.js";

describe("normalizeLocale", () => {
  it("accepts a bare supported subtag", () => {
    expect(normalizeLocale("hu")).toBe("hu");
    expect(normalizeLocale("en")).toBe("en");
  });

  it("drops region and script subtags", () => {
    expect(normalizeLocale("hu-HU")).toBe("hu");
    expect(normalizeLocale("en-GB")).toBe("en");
    expect(normalizeLocale("en_US")).toBe("en");
  });

  it("is case-insensitive and tolerates padding", () => {
    expect(normalizeLocale("  HU  ")).toBe("hu");
    expect(normalizeLocale("En-gb")).toBe("en");
  });

  it("returns undefined for a language with no templates", () => {
    expect(normalizeLocale("de")).toBeUndefined();
    expect(normalizeLocale("sk-SK")).toBeUndefined();
  });

  it("returns undefined for absent or empty values", () => {
    expect(normalizeLocale(null)).toBeUndefined();
    expect(normalizeLocale(undefined)).toBeUndefined();
    expect(normalizeLocale("")).toBeUndefined();
    expect(normalizeLocale("   ")).toBeUndefined();
  });
});

describe("resolveLocale", () => {
  it("prefers the customer over the tenant", () => {
    // The person reading the email is the customer, so an English-speaking
    // patient at a Hungarian clinic gets English.
    expect(resolveLocale({ customerLanguage: "en", tenantLanguage: "hu" })).toBe("en");
  });

  it("falls back to the tenant when the customer has no usable preference", () => {
    expect(resolveLocale({ customerLanguage: null, tenantLanguage: "en" })).toBe("en");
    expect(resolveLocale({ customerLanguage: "de", tenantLanguage: "en" })).toBe("en");
  });

  it("falls back to Hungarian when nothing is usable", () => {
    expect(resolveLocale({})).toBe(FALLBACK_LOCALE);
    expect(resolveLocale({ customerLanguage: "de", tenantLanguage: "fr" })).toBe(FALLBACK_LOCALE);
  });

  it("never returns undefined", () => {
    // A message with no language cannot be rendered, so the decision has to
    // terminate here rather than as a missing key in the renderer.
    expect(resolveLocale({ customerLanguage: null, tenantLanguage: null })).toBeTruthy();
  });
});
