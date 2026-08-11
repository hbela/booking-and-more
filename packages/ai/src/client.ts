import { AppError, ErrorCodes } from "@bam/contracts";
import OpenAI from "openai";

/**
 * The lazy client. CLAUDE.md rule 4: a missing API key must degrade one feature,
 * never crash boot.
 *
 * `getOpenAI` is called at the moment a transcript or an interpretation is
 * actually needed. Until then nothing here runs, which is why an API with no
 * `OPENAI_API_KEY` starts normally, serves the catalogue, takes holds, confirms
 * bookings and sends email exactly as before — and answers 503 on precisely the
 * two routes that cannot work.
 */

export interface OpenAiConfig {
  apiKey: string | undefined;
  transcriptionModel: string;
  interpretationModel: string;
}

let cached: { key: string; client: OpenAI } | undefined;

/**
 * Thrown rather than returned-as-null on purpose.
 *
 * docs/phase-9-owner-onboarding-emails.md §2 is the precedent: an `EmailProvider`
 * that could not deliver reported success anyway, and the failure was invisible
 * for weeks. The equivalent here would be an interpreter that returns an empty
 * envelope when it has no key — a conversation that silently understands nothing
 * and blames the customer's phrasing.
 */
export function conversationUnavailable(): AppError {
  return new AppError(
    ErrorCodes.CONVERSATION_UNAVAILABLE,
    "The assistant is not available. You can still book using the form.",
    { statusCode: 503, report: false },
  );
}

export function getOpenAI(config: OpenAiConfig): OpenAI {
  const { apiKey } = config;

  if (apiKey === undefined || apiKey === "") throw conversationUnavailable();

  // Keyed by the key itself, so a test that builds two apps with two different
  // keys does not silently get the first one's client — the memoisation bug
  // phase-9-owner-onboarding-emails.md §1 spent a day on, in the shape it would
  // take here.
  if (cached?.key === apiKey) return cached.client;

  const client = new OpenAI({ apiKey });
  cached = { key: apiKey, client };

  return client;
}

/** Test seam. Never called in production code. */
export function resetOpenAiClient(): void {
  cached = undefined;
}

export function isConfigured(config: OpenAiConfig): boolean {
  return config.apiKey !== undefined && config.apiKey !== "";
}
