import { describe, expect, it } from "vitest";
import { SLUG_PATTERN } from "@bam/contracts";
import { slugify } from "./service.service.js";
import { createServiceBodySchema } from "./service.schemas.js";

/**
 * Pure unit tests for the parts of the service module that do not need a
 * database. The rest of the module's behaviour — tenant scoping, archiving,
 * translations, the public filters — is covered end to end in catalogue.test.ts.
 */

describe("slugify", () => {
  it("produces slugs the shared pattern accepts", () => {
    const names = [
      "Consultation",
      "Fogkő-eltávolítás",
      "Teeth   whitening!!",
      "  Leading and trailing  ",
      "Root canal (molar)",
      "30% off checkup",
    ];

    for (const name of names) {
      const slug = slugify(name);
      expect(slug, `"${name}" produced "${slug}"`).toMatch(SLUG_PATTERN);
    }
  });

  it("folds Hungarian accents to what someone would type into a URL bar", () => {
    expect(slugify("Fogkő-eltávolítás")).toBe("fogko-eltavolitas");
    expect(slugify("Árvíztűrő tükörfúrógép")).toBe("arvizturo-tukorfurogep");
  });

  it("collapses runs of punctuation into single hyphens", () => {
    expect(slugify("Teeth   whitening!!")).toBe("teeth-whitening");
    expect(slugify("Root canal (molar)")).toBe("root-canal-molar");
  });

  it("never leaves a leading or trailing hyphen, even after truncation", () => {
    // Truncating at 80 characters can land mid-separator; the result still has
    // to be a valid slug.
    const long = `${"a".repeat(79)} tail`;
    const slug = slugify(long);

    expect(slug.length).toBeLessThanOrEqual(80);
    expect(slug).toMatch(SLUG_PATTERN);
  });

  it("returns something unusable rather than nonsense for a name with no Latin letters", () => {
    // The caller checks for this and asks the user for a slug instead of
    // inventing one.
    expect(slugify("日本語")).toBe("");
    expect(slugify("!!!")).toBe("");
  });
});

describe("createServiceBodySchema", () => {
  const valid = { name: "Consultation", durationMinutes: 30 };

  it("accepts a service with no price at all", () => {
    // "Price on consultation" is a real answer, and different from free.
    expect(createServiceBodySchema.safeParse(valid).success).toBe(true);
  });

  it("rejects an amount with no currency", () => {
    const result = createServiceBodySchema.safeParse({ ...valid, priceMinor: 5000 });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["currency"]);
  });

  it("accepts a complete price and upper-cases the currency", () => {
    const result = createServiceBodySchema.safeParse({
      ...valid,
      priceMinor: 5000,
      currency: "huf",
    });

    expect(result.success).toBe(true);
    expect(result.data?.currency).toBe("HUF");
  });

  it("treats a zero price as a real value", () => {
    const result = createServiceBodySchema.safeParse({ ...valid, priceMinor: 0, currency: "HUF" });

    expect(result.success).toBe(true);
    expect(result.data?.priceMinor).toBe(0);
  });

  it("refuses a duration outside anything a diary can hold", () => {
    expect(createServiceBodySchema.safeParse({ ...valid, durationMinutes: 0 }).success).toBe(false);
    expect(createServiceBodySchema.safeParse({ ...valid, durationMinutes: 2000 }).success).toBe(
      false,
    );
  });
});
