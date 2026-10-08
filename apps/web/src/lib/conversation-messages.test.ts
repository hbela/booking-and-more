import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  conversationMessages,
  renderMessage,
  renderTranscriptMessage,
} from "./conversation-messages";

describe("chat messages", () => {
  it("translates every message emitted by the conversation engine in all four languages", () => {
    const templates = readFileSync(
      new URL("../../../../packages/conversation-engine/src/templates.ts", import.meta.url),
      "utf8",
    );
    const keys = [...templates.matchAll(/"(conversation\.[\w.]+)"/g)].map((match) => match[1]!);
    expect(keys.length).toBeGreaterThan(20);
    for (const key of keys) {
      for (const locale of ["hu", "en", "de", "fr"] as const) {
        expect(conversationMessages[key]?.[locale], key).toBeTruthy();
        expect(renderMessage({ key, ui: "NONE" }, locale)).not.toMatch(/^conversation\./);
      }
    }
  });

  it("shows a Hungarian clarification instead of the raw error key", () => {
    expect(renderMessage({ key: "conversation.error.unclear", ui: "NONE" }, "hu")).toContain(
      "Időpontot szeretne foglalni",
    );
  });

  it("uses readable fallback text for a future message key", () => {
    expect(renderMessage({ key: "conversation.error.future", ui: "NONE" }, "en")).toBe(
      conversationMessages["conversation.error.unclear"]!.en,
    );
  });

  it("preserves a grounded business answer", () => {
    expect(
      renderMessage(
        { key: "conversation.answer", params: { answer: "Nyitva: 9–17." }, ui: "NONE" },
        "hu",
      ),
    ).toBe("Nyitva: 9–17.");
  });

  describe("in a staff transcript", () => {
    it("shows a templated reply in the language the customer chatted in", () => {
      const greeting = { sender: "ASSISTANT", content: "conversation.greeting", structured: {} };
      expect(renderTranscriptMessage(greeting, "en")).toBe(
        conversationMessages["conversation.greeting"]!.en,
      );
      expect(renderTranscriptMessage(greeting, "hu")).toBe(
        conversationMessages["conversation.greeting"]!.hu,
      );
    });

    it("shows a model-written answer as written", () => {
      expect(
        renderTranscriptMessage(
          { sender: "ASSISTANT", content: "conversation.answer", structured: { answer: "Igen." } },
          "hu",
        ),
      ).toBe("Igen.");
    });

    it("never looks up what a customer typed", () => {
      expect(
        renderTranscriptMessage(
          { sender: "CUSTOMER", content: "conversation.greeting", structured: null },
          "en",
        ),
      ).toBe("conversation.greeting");
    });

    it("keeps an unknown key as stored rather than guessing", () => {
      expect(
        renderTranscriptMessage(
          { sender: "ASSISTANT", content: "conversation.future.thing", structured: {} },
          "en",
        ),
      ).toBe("conversation.future.thing");
    });
  });
});
