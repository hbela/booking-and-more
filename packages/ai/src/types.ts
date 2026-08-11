import type { CommandEnvelope } from "@bam/contracts";

/**
 * The interfaces. tech-impl §20: *the AI package should expose interfaces, not
 * provider-specific behavior.*
 *
 * That is not architectural decoration here. The open question
 * docs/phase-8-push-to-talk-voice.md flags is how well Hungarian transcribes,
 * and the answer changes which model — possibly which vendor — is right. A
 * seam at this line means that is a swap; without one it is a rewrite of the
 * conversation service.
 */

/**
 * What a call cost, reported alongside what it produced.
 *
 * Returned rather than logged, so the caller can meter inside its own
 * transaction (`UsageService.record`). A provider that wrote usage itself would
 * need a database, which is exactly the dependency this package must not have.
 */
export interface AiUsage {
  provider: string;
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  /** Audio seconds, rounded up — in the tenant's favour, never in ours. */
  audioSeconds?: number;
  /** Our estimate, in minor units of the platform's billing currency. */
  estimatedCostMinor: number;
}

export interface AudioInput {
  data: Buffer | Uint8Array;
  /**
   * Measured by the route before the call, not read back from the provider.
   * The quota gate has to know how many seconds it is about to authorise
   * *before* authorising them; a figure that arrives with the answer is an
   * accounting entry rather than a limit.
   */
  durationMs: number;
  /** The validated MIME type — the route has already sniffed the magic bytes. */
  contentType: string;
  filename: string;
  /**
   * A hint, never a constraint. Telling the model the conversation is Hungarian
   * improves the transcript; telling it the customer *must* be speaking
   * Hungarian would mangle an English speaker on a Hungarian page.
   */
  languageHint?: string | undefined;
}

export interface TranscriptionResult {
  transcript: string;
  detectedLanguage?: string | undefined;
  /** As measured by us before the call, not as reported by the provider. */
  audioDurationMs: number;
  usage: AiUsage;
}

export interface TranscriptionProvider {
  transcribe(input: AudioInput): Promise<TranscriptionResult>;
}

/** One prior turn, trimmed to what the model needs to disambiguate this one. */
export interface ConversationTurn {
  role: "customer" | "assistant";
  content: string;
}

/** The catalogue the model may name, and nothing else. */
export interface InterpretationCatalogue {
  services: { id: string; name: string }[];
  providers: { id: string; name: string }[];
  locations: { id: string; name: string }[];
}

export interface InterpretationInput {
  utterance: string;
  /** BCP-47. Seeds the prompt (tech-impl §38) — not a filter on the answer. */
  locale: string;
  /** IANA zone, so the model knows which "today" the customer means. */
  timezone: string;
  /** Where the conversation is, so a bare "yes" is read in context. */
  state: string;
  /** Recent turns. Summarised rather than replayed whole (PRD §11). */
  history?: ConversationTurn[] | undefined;
  catalogue: InterpretationCatalogue;
}

export interface InterpretationResult {
  /** Raw. The caller runs `parseCommand` — this package never executes. */
  envelope: CommandEnvelope;
  usage: AiUsage;
}

export interface IntentInterpreter {
  interpret(input: InterpretationInput): Promise<InterpretationResult>;
}

export interface ResponseInput {
  locale: string;
  /** The template key the engine chose, for a composer that wants to vary it. */
  messageKey: string;
  params?: Record<string, string | number> | undefined;
}

export interface ResponseResult {
  /** A message key, still. A composer that returns prose is a composer that
   *  can be steered by a tenant's service name. */
  key: string;
  params?: Record<string, string | number> | undefined;
  usage?: AiUsage | undefined;
}

/**
 * Declared because tech-impl §20 declares it, and implemented only by
 * `TemplateResponseComposer`, which reaches no model at all.
 *
 * The spec's own guidance is to prefer deterministic templates for common
 * booking steps; this project takes that further and uses them for every step,
 * for the reasons in `@bam/conversation-engine`'s `templates.ts`. The interface
 * survives so that a tenant who one day wants a chattier assistant is a new
 * implementation rather than a new seam.
 */
export interface ResponseComposer {
  compose(input: ResponseInput): Promise<ResponseResult>;
}

/** Everything the conversation service needs, in one bag. */
export interface AiProviders {
  transcription: TranscriptionProvider;
  interpreter: IntentInterpreter;
  composer: ResponseComposer;
}
