import { beforeEach, describe, expect, it, vi } from "vitest";

import type { InterpretationInput } from "./types.js";

const stream = vi.hoisted(() => vi.fn());

vi.mock("./client.js", () => ({
  getAnthropic: () => ({ messages: { stream } }),
}));

import { AnthropicIntentInterpreter } from "./interpreter.js";

const input: InterpretationInput = {
  utterance: "I would like an appointment",
  locale: "en",
  timezone: "Europe/Budapest",
  state: "START",
  catalogue: { services: [], providers: [], locations: [] },
};

describe("AnthropicIntentInterpreter", () => {
  beforeEach(() => {
    stream.mockReset();
    stream.mockReturnValue({
      finalMessage: () =>
        Promise.resolve({
          usage: { input_tokens: 12, output_tokens: 5 },
          content: [
            {
              type: "tool_use",
              input: {
                intent: "LIST_SERVICES",
                confidence: 0.95,
                parameters: {},
                missingFields: [],
                requiresConfirmation: false,
              },
            },
          ],
        }),
    });
  });

  it("does not send model-specific deprecated sampling parameters", async () => {
    const interpreter = new AnthropicIntentInterpreter({
      apiKey: "test-key",
      chatModel: "claude-sonnet-5",
      maxOutputTokens: 1_024,
    });

    await interpreter.interpret(input);

    expect(stream).toHaveBeenCalledOnce();
    expect(stream.mock.calls[0]?.[0]).not.toHaveProperty("temperature");
  });
});
