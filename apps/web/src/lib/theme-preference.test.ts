import { describe, expect, it } from "vitest";
import { parseThemePreference, readThemePreference } from "./theme-preference";

describe("parseThemePreference", () => {
  it("accepts the two real values", () => {
    expect(parseThemePreference("light")).toBe("light");
    expect(parseThemePreference("dark")).toBe("dark");
  });

  // null is not an error path — it is the third state, "follow the system".
  it("returns null for anything else", () => {
    expect(parseThemePreference(undefined)).toBeNull();
    expect(parseThemePreference(null)).toBeNull();
    expect(parseThemePreference("")).toBeNull();
    expect(parseThemePreference("system")).toBeNull();
    expect(parseThemePreference("Dark")).toBeNull();
  });
});

describe("readThemePreference", () => {
  it("finds the cookie among others", () => {
    expect(readThemePreference("NEXT_LOCALE=hu; bam.theme=dark; bam.locale=en")).toBe("dark");
  });

  it("finds it first or last in the string", () => {
    expect(readThemePreference("bam.theme=light")).toBe("light");
    expect(readThemePreference("a=1; bam.theme=light")).toBe("light");
    expect(readThemePreference("bam.theme=light; a=1")).toBe("light");
  });

  it("returns null when absent", () => {
    expect(readThemePreference("")).toBeNull();
    expect(readThemePreference("bam.locale=hu")).toBeNull();
  });

  // The cookie is expired rather than set to a value when the visitor picks
  // "system", so an empty one has to read as absent.
  it("treats an emptied cookie as absent", () => {
    expect(readThemePreference("bam.theme=; a=1")).toBeNull();
  });

  // The reason the lookup splits rather than building a regex from a constant
  // containing a dot: `.` would match any character.
  it("does not match a near-miss name", () => {
    expect(readThemePreference("bamXtheme=dark")).toBeNull();
    expect(readThemePreference("notbam.theme=dark")).toBeNull();
  });

  it("ignores a stored value that is not a theme", () => {
    expect(readThemePreference("bam.theme=purple")).toBeNull();
  });
});
