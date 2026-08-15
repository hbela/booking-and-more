import { describe, expect, it } from "vitest";
import { advanceNote, DEFAULT_MAXIMUM_ADVANCE_DAYS, SHORT_HORIZON_DAYS } from "./catalogue-form";

/**
 * The regression suite for a booking horizon of 1.
 *
 * A live service was saved with `maximum_advance_days = 1` — today and
 * tomorrow, and nothing else. The engine intersects that window before it
 * looks at any schedule, so the booking page went silent while every dashboard
 * screen still showed a healthy provider with a full week of hours.
 */
describe("advanceNote", () => {
  it("names the inherited default for a blank box", () => {
    expect(advanceNote("")).toEqual({
      key: "advanceInherit",
      days: DEFAULT_MAXIMUM_ADVANCE_DAYS,
    });
    expect(advanceNote("   ")).toEqual({
      key: "advanceInherit",
      days: DEFAULT_MAXIMUM_ADVANCE_DAYS,
    });
  });

  it("warns about the value that caused the incident", () => {
    expect(advanceNote("1")).toEqual({ key: "advanceShort", days: 1 });
  });

  it("warns below the threshold and stops at it", () => {
    expect(advanceNote(String(SHORT_HORIZON_DAYS - 1)).key).toBe("advanceShort");
    expect(advanceNote(String(SHORT_HORIZON_DAYS)).key).toBe("advanceDays");
  });

  it("states the horizon plainly for an ordinary value", () => {
    expect(advanceNote("90")).toEqual({ key: "advanceDays", days: 90 });
    expect(advanceNote("730")).toEqual({ key: "advanceDays", days: 730 });
  });

  it("falls back to the default rather than asserting nonsense", () => {
    // The input is `type="number" min={1}`, so these are not reachable through
    // the UI — but a note that read "only the next -3 days" would be worse than
    // one that describes the value the server will actually apply.
    for (const value of ["abc", "0", "-3"]) {
      expect(advanceNote(value).key).toBe("advanceInherit");
    }
  });
});
import { diffPatch, numberValue, textValue } from "./catalogue-form";

describe("an empty box means two different things", () => {
  it("is omitted on create and null on patch", () => {
    // Not interchangeable. `email: null` fails createProviderBodySchema
    // outright, and an omitted `email` can never clear a stored one.
    expect(textValue("create", "")).toBeUndefined();
    expect(textValue("patch", "")).toBeNull();
  });

  it("never sends the empty string", () => {
    // JSON.stringify drops undefined but transmits "", and z.email(),
    // slugSchema and timezoneSchema all reject "".
    expect(textValue("create", "   ")).toBeUndefined();
    expect(textValue("patch", "   ")).toBeNull();
  });

  it("trims what it does send", () => {
    expect(textValue("create", "  Dr. Kovács  ")).toBe("Dr. Kovács");
  });
});

describe("numbers", () => {
  it("keeps blank distinct from zero", () => {
    // Blank means "inherit"; zero means "bookable up to the last second".
    // Collapsing them silently changes a booking window.
    expect(numberValue("patch", "")).toBeNull();
    expect(numberValue("patch", "0")).toBe(0);
    expect(numberValue("create", "")).toBeUndefined();
  });

  it("reads a number, and drops nonsense rather than sending NaN", () => {
    expect(numberValue("patch", "120")).toBe(120);
    expect(numberValue("patch", "abc")).toBeUndefined();
  });
});

describe("diffing a patch", () => {
  it("sends only what changed", () => {
    // No version column on catalogue rows, so a full-body PATCH would silently
    // overwrite a colleague's edit to a field this user never touched.
    const before = { name: "Cleaning", durationMinutes: 45, active: true };
    const after = { name: "Deep cleaning", durationMinutes: 45, active: true };

    expect(diffPatch(before, after)).toEqual({ name: "Deep cleaning" });
  });

  it("sends an explicit null, because clearing a field is a change", () => {
    const before: { description: string | null } = { description: "Old copy" };
    const after: { description: string | null } = { description: null };

    expect(diffPatch(before, after)).toEqual({ description: null });
  });

  it("compares arrays by content, not identity", () => {
    // `languages` is rebuilt on every keystroke by the checkbox group; an equal
    // set is not an edit.
    const before = { languages: ["hu", "en"] };

    expect(diffPatch(before, { languages: ["hu", "en"] })).toEqual({});
    expect(diffPatch(before, { languages: ["hu"] })).toEqual({ languages: ["hu"] });
  });

  it("is empty when nothing moved, so a no-op save is a no-op request", () => {
    const state = { name: "Cleaning", priceMinor: 1_500_000 };
    expect(diffPatch(state, { ...state })).toEqual({});
  });
});
