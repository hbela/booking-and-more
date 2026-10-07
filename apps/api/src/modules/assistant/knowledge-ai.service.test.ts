import { describe, expect, it } from "vitest";
import { splitForTranslation } from "./knowledge-ai.service.js";

/** docs/phase-12-knowledge-allowance-and-prompt-caching.md §3.4 */
describe("splitting a long text for translation", () => {
  it("leaves a short text alone", () => {
    expect(splitForTranslation("Rövid szöveg.", 100)).toEqual(["Rövid szöveg."]);
  });

  it("splits at blank lines, keeping paragraphs whole and in order", () => {
    const text = ["a".repeat(40), "b".repeat(40), "c".repeat(40)].join("\n\n");
    const pieces = splitForTranslation(text, 90);
    expect(pieces).toEqual([`${"a".repeat(40)}\n\n${"b".repeat(40)}`, "c".repeat(40)]);
    expect(pieces.join("\n\n")).toBe(text);
  });

  it("splits a paragraph longer than a piece at sentence ends, never past the limit", () => {
    const sentence = `${"x".repeat(28)}. `;
    const text = `Első bekezdés.\n\n${sentence.repeat(10)}`;
    const pieces = splitForTranslation(text, 100);
    expect(pieces[0]).toBe("Első bekezdés.");
    expect(pieces.every((piece) => piece.length <= 100)).toBe(true);
    expect(pieces.slice(1).join("")).toBe(sentence.repeat(10));
  });
});
