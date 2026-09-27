import { beforeEach, describe, expect, it, vi } from "vitest";

import type { InterpretationInput } from "./types.js";

const stream = vi.hoisted(() => vi.fn());
const countTokens = vi.hoisted(() => vi.fn());

vi.mock("./client.js", () => ({
  getAnthropic: () => ({ messages: { stream, countTokens } }),
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
  it("counts the exact system, tools and history and bounds output and request lifetime", async () => {
    countTokens.mockResolvedValueOnce({ input_tokens: 1234 });
    const interpreter = new AnthropicIntentInterpreter({
      apiKey: "test",
      chatModel: "claude-sonnet-5",
      maxOutputTokens: 1024,
    });
    const request = {
      ...input,
      history: [{ role: "customer" as const, content: "previous message" }],
      maxOutputTokens: 123,
      timeoutMs: 500,
    };
    expect(await interpreter.countTokens(request)).toBe(1234);
    await interpreter.interpret(request);
    const counted = countTokens.mock.calls.at(-1)![0];
    const sent = stream.mock.calls.at(-1)![0];
    for (const field of ["model", "system", "tools", "tool_choice", "messages"])
      expect(counted[field]).toEqual(sent[field]);
    expect(sent.max_tokens).toBe(123);
    expect(stream.mock.calls.at(-1)![1]).toMatchObject({ maxRetries: 0, timeout: 500 });
    expect(stream.mock.calls.at(-1)![1].signal).toBeInstanceOf(AbortSignal);
  });
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
