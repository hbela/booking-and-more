import { describe, expect, it } from "vitest";
import { splitServiceDescription } from "./service-description";

describe("splitServiceDescription", () => {
  it("handles missing and short descriptions without an empty disclosure", () => {
    expect(splitServiceDescription(null)).toEqual({ short: "", long: "" });
    expect(splitServiceDescription("  A short summary.  ")).toEqual({
      short: "A short summary.",
      long: "",
    });
  });

  it("supports a standalone separator and preserves detail paragraphs", () => {
    expect(splitServiceDescription("Summary\r\n---\r\nDetails\r\n\r\nMore details")).toEqual({
      short: "Summary",
      long: "Details\r\n\r\nMore details",
    });
    expect(splitServiceDescription("Summary --- still summary").long).toBe("");
  });

  it.each([
    "Short Description: Summary\nLong Description: Details",
    "**Short Description:** Summary **Long Description:** Details",
    "## Rövid leírás\nSummary\n## Részletes leírás\nDetails",
    "Rövid leirás: Summary\nLeirás: Details",
    "Rövid leírás: Summary\n---\nRészletes leírás: Details",
  ])("supports localized and Markdown headings: %s", (description) => {
    expect(splitServiceDescription(description)).toEqual({ short: "Summary", long: "Details" });
  });

  it("recognizes the existing dental description's inline section headings", () => {
    expect(
      splitServiceDescription(
        "**Rövid leírás:** Fogkőeltávolítás. **Miért fontos a helyes szájhigiénia:** Részletek. **Mit okoz a fogkő:** További részletek.",
      ),
    ).toEqual({
      short: "Fogkőeltávolítás.",
      long: "**Miért fontos a helyes szájhigiénia:** Részletek. **Mit okoz a fogkő:** További részletek.",
    });
  });

  it("keeps all legacy text available behind a bounded preview", () => {
    const text = "A detailed service description. ".repeat(30);
    const result = splitServiceDescription(text);
    expect(result.short.length).toBeLessThanOrEqual(241);
    expect(result.short.endsWith("…")).toBe(true);
    expect(result.long).toBe(text.trim());
  });

  it("supports details without a summary and an empty details section", () => {
    expect(splitServiceDescription("Long Description: Details")).toEqual({
      short: "",
      long: "Details",
    });
    expect(splitServiceDescription("Summary\n---")).toEqual({ short: "Summary", long: "" });
  });
});
