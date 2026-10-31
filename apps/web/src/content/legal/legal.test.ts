import { describe, expect, it } from "vitest";
import { LEGAL_DOCUMENTS } from "./index";

describe("legal documents", () => {
  // Links such as the booking flow's `/privacy#patients` point at an anchor;
  // the two languages must offer the same ones, or a link works in one only.
  it.each(Object.entries(LEGAL_DOCUMENTS))(
    "%s has the same sections in both languages",
    (_, byLocale) => {
      expect(byLocale.hu.sections.map((section) => section.id)).toEqual(
        byLocale.en.sections.map((section) => section.id),
      );
      expect(byLocale.hu.effective).toBe(byLocale.en.effective);
    },
  );

  it("has unique section anchors", () => {
    for (const byLocale of Object.values(LEGAL_DOCUMENTS)) {
      const ids = byLocale.en.sections.map((section) => section.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it("keeps the anchor the booking flow links to", () => {
    expect(LEGAL_DOCUMENTS.privacy.hu.sections.some((section) => section.id === "patients")).toBe(
      true,
    );
  });
});
