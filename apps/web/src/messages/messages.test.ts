import { describe, expect, it } from "vitest";
import en from "./en.json";
import hu from "./hu.json";

/**
 * The two catalogues must carry exactly the same keys.
 *
 * Nothing enforced this before, and next-intl fails softly: a key missing from
 * one locale renders the key path itself, which reads as a broken string to a
 * Hungarian user and is invisible to an English-speaking developer. With ~380
 * keys in twelve namespaces, "add it to both" is not a rule anybody can hold.
 *
 * The same reasoning as `i18n/routing.test.ts`, which reads the route directory
 * off disk rather than trusting a hand-maintained list to stay in step.
 */
function paths(value: unknown, prefix = ""): string[] {
  if (typeof value !== "object" || value === null) {
    return [prefix];
  }

  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
    paths(child, prefix ? `${prefix}.${key}` : key),
  );
}

describe("message catalogues", () => {
  const enPaths = paths(en).sort();
  const huPaths = paths(hu).sort();

  it("hu.json defines every key en.json does", () => {
    expect(enPaths.filter((key) => !huPaths.includes(key))).toEqual([]);
  });

  it("en.json defines every key hu.json does", () => {
    expect(huPaths.filter((key) => !enPaths.includes(key))).toEqual([]);
  });

  // A key that exists in both but was copied across untranslated is a different
  // failure and not one a test can judge — `appName` is deliberately identical.
  // This only catches the structural half.
  it("has no empty strings", () => {
    const empties = [
      ...Object.entries({ en, hu }).flatMap(([locale, catalogue]) =>
        paths(catalogue)
          .filter((key) => {
            const value = key
              .split(".")
              .reduce<unknown>(
                (node, part) => (node as Record<string, unknown> | undefined)?.[part],
                catalogue,
              );

            return typeof value === "string" && value.trim() === "";
          })
          .map((key) => `${locale}:${key}`),
      ),
    ];

    expect(empties).toEqual([]);
  });
});
