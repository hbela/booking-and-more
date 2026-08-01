import { describe, expect, it } from "vitest";

import { domainSchema, normalizeDomain } from "./domain.js";

describe("normalizeDomain", () => {
  it("accepts a bare domain unchanged", () => {
    expect(normalizeDomain("wellness.hu")).toBe("wellness.hu");
  });

  it("collapses the forms one prospect gets typed as", () => {
    // The whole point: these are one business, and a unique constraint that
    // thinks otherwise provisions them three times.
    const forms = [
      "wellness.hu",
      "WELLNESS.HU",
      "  Wellness.hu  ",
      "www.wellness.hu",
      "https://wellness.hu",
      "https://www.wellness.hu/",
      "http://WWW.Wellness.HU/booking?utm=x",
      "wellness.hu.",
      "wellness.hu:443",
    ];

    for (const form of forms) {
      expect(normalizeDomain(form), form).toBe("wellness.hu");
    }
  });

  it("keeps subdomains that are not www", () => {
    // booking.wellness.hu is plausibly a different tenant; www is not.
    expect(normalizeDomain("booking.wellness.hu")).toBe("booking.wellness.hu");
  });

  it("handles multi-part TLDs", () => {
    expect(normalizeDomain("clinic.co.uk")).toBe("clinic.co.uk");
  });

  it("strips credentials", () => {
    expect(normalizeDomain("https://user:pass@wellness.hu")).toBe("wellness.hu");
  });

  it("rejects what is obviously not a domain", () => {
    for (const value of [
      "",
      "   ",
      "wellness", // no dot
      "not a domain",
      "user@wellness.hu", // an email address, not a domain
      "192.168.0.1", // numeric TLD
      "-wellness.hu",
      "wellness-.hu",
      "wellness..hu",
      "wellness.h", // one-letter TLD
      "https://",
    ]) {
      expect(normalizeDomain(value), value).toBeUndefined();
    }
  });

  it("rejects a domain longer than the column allows", () => {
    const long = `${"a".repeat(250)}.hu`;
    expect(normalizeDomain(long)).toBeUndefined();
  });

  it("is idempotent", () => {
    // Re-normalising a stored value must not change it, or a second write
    // would fail to match the first.
    const once = normalizeDomain("https://WWW.Wellness.HU/x");
    expect(once).toBeDefined();
    expect(normalizeDomain(once!)).toBe(once);
  });
});

describe("domainSchema", () => {
  it("parses and normalizes in one step", () => {
    expect(domainSchema.parse("  HTTPS://WWW.Wellness.HU/  ")).toBe("wellness.hu");
  });

  it("rejects an invalid domain with a usable message", () => {
    const result = domainSchema.safeParse("not a domain");

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toMatch(/wellness\.hu/u);
    }
  });
});
