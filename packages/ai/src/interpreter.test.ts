import { beforeEach, describe, expect, it, vi } from "vitest";

import type { InterpretationInput } from "./types.js";

const stream = vi.hoisted(() => vi.fn());
const countTokens = vi.hoisted(() => vi.fn());

vi.mock("./client.js", () => ({
  getAnthropic: () => ({ messages: { stream, countTokens } }),
}));

import { AnthropicIntentInterpreter } from "./interpreter.js";
import { tokenUsage } from "./pricing.js";
import { buildSystemBlocks } from "./prompt.js";

const CEILING = 45_000;

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
      promptBlockCharacterCeiling: CEILING,
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
      promptBlockCharacterCeiling: CEILING,
    });

    await interpreter.interpret(input);

    expect(stream).toHaveBeenCalledOnce();
    expect(stream.mock.calls[0]?.[0]).not.toHaveProperty("temperature");
  });
});

/** docs/phase-12-knowledge-allowance-and-prompt-caching.md */
describe("prompt caching", () => {
  const knowledge = {
    ...input,
    bookableFacts: "Business: Wellness",
    businessContext: "Profile.",
  };

  it("keeps everything that changes per turn out of the cached block", () => {
    const first = buildSystemBlocks(knowledge, CEILING);
    const later = buildSystemBlocks(
      {
        ...knowledge,
        state: "SELECTING_SLOT",
        locale: "hu",
        timezone: "America/New_York",
        utterance: "something else",
      },
      CEILING,
    );
    expect(later.cached).toBe(first.cached);
    expect(later.turn).not.toBe(first.turn);
    expect(later.turn).toContain("SELECTING_SLOT");
    expect(first.cached).not.toContain("Europe/Budapest");
    expect(first.cached).toContain("<business-description>\nProfile.");
  });

  it("marks the cached block and sends the per-turn block after it", async () => {
    const interpreter = new AnthropicIntentInterpreter({
      apiKey: "test",
      chatModel: "claude-sonnet-5",
      maxOutputTokens: 1024,
      promptBlockCharacterCeiling: CEILING,
    });
    await interpreter.interpret(knowledge);
    const system = stream.mock.calls.at(-1)![0].system as {
      text: string;
      cache_control?: unknown;
    }[];
    expect(system).toHaveLength(2);
    expect(system[0]!.cache_control).toEqual({ type: "ephemeral" });
    expect(system[1]!.cache_control).toBeUndefined();
    expect(system[1]!.text).toContain("START");
  });

  it("carries a block up to the configured ceiling and cuts it there", () => {
    // @bam/config keeps the ceiling above the allowance; here only the cut matters.
    const blocks = (text: string) =>
      buildSystemBlocks({ ...knowledge, businessContext: text }, 1_000).cached;
    expect(blocks("x".repeat(1_000))).toContain("x".repeat(1_000));
    expect(blocks("y".repeat(1_001))).not.toContain("y".repeat(1_001));
    expect(blocks("y".repeat(1_001))).toContain("y".repeat(1_000));
  });

  it("meters cached input at what it costs", () => {
    const usage = tokenUsage({
      provider: "anthropic",
      model: "claude-sonnet-5",
      inputTokens: 1_000,
      outputTokens: 100,
      cacheWriteTokens: 20_000,
      cacheReadTokens: 0,
    });
    expect(usage.inputTokens).toBe(26_000);
    expect(usage.cacheWriteTokens).toBe(20_000);

    const read = tokenUsage({
      provider: "anthropic",
      model: "claude-sonnet-5",
      inputTokens: 1_000,
      outputTokens: 100,
      cacheReadTokens: 20_000,
      cacheWriteTokens: null,
    });
    expect(read.inputTokens).toBe(3_000);
    expect(read).not.toHaveProperty("cacheWriteTokens");
    // Equivalents × the input price is the input's cost.
    expect(read.estimatedCostMinor).toBe(Math.ceil((3_000 * 200 + 100 * 1_000) / 1_000_000));
  });
});
