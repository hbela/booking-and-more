/**
 * @bam/ai — the only package in the workspace that talks to a model.
 * tech-impl §20 · docs/phase-7-chat-booking.md §10.
 *
 * It exposes interfaces and two implementations of each: one that calls OpenAI
 * and one that does not, so every path through the conversation can be tested
 * without a network, a key or a bill.
 *
 * What it must never gain is Fastify, Prisma or Redis. A provider that can read
 * the database is a provider that can be prompt-injected into reading the wrong
 * tenant's — and the usage it reports is returned to the caller precisely so
 * that metering can happen in a transaction this package cannot see.
 */

export { conversationUnavailable, getOpenAI, isConfigured, resetOpenAiClient } from "./client.js";
export type { OpenAiConfig } from "./client.js";

export { OpenAIIntentInterpreter } from "./interpreter.js";
export { OpenAITranscriptionProvider } from "./transcription.js";
export { TemplateResponseComposer } from "./composer.js";

export { buildSystemPrompt, buildUserMessages, HISTORY_TURNS } from "./prompt.js";
export { audioCostMinor, audioUsage, tokenCostMinor, tokenUsage } from "./pricing.js";

export {
  envelope,
  fakeProviders,
  FailingTranscriptionProvider,
  FakeIntentInterpreter,
  FakeTranscriptionProvider,
} from "./fake.js";
export type { FakeProviders, ScriptedInterpretation } from "./fake.js";

export type {
  AiProviders,
  AiUsage,
  AudioInput,
  ConversationTurn,
  IntentInterpreter,
  InterpretationCatalogue,
  InterpretationInput,
  InterpretationResult,
  ResponseComposer,
  ResponseInput,
  ResponseResult,
  TranscriptionProvider,
  TranscriptionResult,
} from "./types.js";
