import type { AiUsage } from "./types.js";

/**
 * What a call cost us, estimated.
 *
 * *Estimated* is the operative word and it is in the column name too
 * (`estimated_cost_minor`). This table is for two questions — "is this tenant
 * expensive" and "is the quota set anywhere near reality" — not for an invoice.
 * The provider's own billing is the authority, and when the two disagree the
 * provider is right.
 *
 * Prices are in USD cents per million tokens / per minute of audio, current as
 * of 2026-08. An unknown model costs the most expensive known rate rather than
 * zero: a model nobody added to this table must show up as expensive, not as
 * free, or the first thing anybody notices is the bill.
 */

interface TokenPrice {
  /** Cents per million input tokens. */
  input: number;
  /** Cents per million output tokens. */
  output: number;
}

const TOKEN_PRICES: Record<string, TokenPrice> = {
  "gpt-4o-mini": { input: 15, output: 60 },
  "gpt-4o": { input: 250, output: 1_000 },
  "gpt-4.1-mini": { input: 40, output: 160 },
  "gpt-4.1-nano": { input: 10, output: 40 },
};

/** Cents per minute of audio. */
const AUDIO_PRICES: Record<string, number> = {
  "gpt-4o-mini-transcribe": 0.3,
  "gpt-4o-transcribe": 0.6,
  "whisper-1": 0.6,
};

const UNKNOWN_TOKEN_PRICE: TokenPrice = { input: 250, output: 1_000 };
const UNKNOWN_AUDIO_PRICE = 0.6;

/**
 * Rounded up, always.
 *
 * Every individual call here costs a fraction of a cent, so rounding down would
 * record a month of conversations as costing nothing. Rounding up over-reports
 * slightly, which is the direction that makes somebody look at it.
 */
export function tokenCostMinor(args: {
  model: string;
  inputTokens: number;
  outputTokens: number;
}): number {
  const price = TOKEN_PRICES[args.model] ?? UNKNOWN_TOKEN_PRICE;

  const cents =
    (args.inputTokens * price.input + args.outputTokens * price.output) / 1_000_000;

  return Math.ceil(cents);
}

export function audioCostMinor(args: { model: string; seconds: number }): number {
  const perMinute = AUDIO_PRICES[args.model] ?? UNKNOWN_AUDIO_PRICE;

  return Math.ceil((args.seconds / 60) * perMinute);
}

export function tokenUsage(args: {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
}): AiUsage {
  return {
    provider: args.provider,
    model: args.model,
    inputTokens: args.inputTokens,
    outputTokens: args.outputTokens,
    estimatedCostMinor: tokenCostMinor(args),
  };
}

export function audioUsage(args: {
  provider: string;
  model: string;
  seconds: number;
}): AiUsage {
  return {
    provider: args.provider,
    model: args.model,
    audioSeconds: args.seconds,
    estimatedCostMinor: audioCostMinor(args),
  };
}
