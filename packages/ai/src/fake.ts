import type { CommandEnvelope } from "@bam/contracts";

import { TemplateResponseComposer } from "./composer.js";
import type {
  AiProviders,
  AudioInput,
  IntentInterpreter,
  InterpretationInput,
  InterpretationResult,
  TranscriptionProvider,
  TranscriptionResult,
} from "./types.js";

/**
 * Deterministic stand-ins, so the whole conversation layer is testable without a
 * network, an API key, or a bill.
 *
 * These are not mocks in the "assert it was called" sense — they are scripted
 * providers. A test hands them the envelope it wants back and then asserts on
 * what the *conversation* did with it, which is the part that has bugs. The
 * model's own accuracy is not something an integration test can assert anyway.
 */

export interface ScriptedInterpretation {
  envelope: CommandEnvelope;
  inputTokens?: number;
  outputTokens?: number;
}

export class FakeIntentInterpreter implements IntentInterpreter {
  /** Every input it was given, in order. */
  readonly calls: InterpretationInput[] = [];

  private readonly script: ScriptedInterpretation[] = [];
  private last: ScriptedInterpretation | undefined;

  /**
   * Queue one answer. Answers are consumed in order; once the queue is empty the
   * most recent one repeats.
   *
   * Repeating rather than throwing matters because a conversation makes turns a
   * test does not always care to script — but *consuming* in order matters more,
   * and an earlier version that only shifted when more than one answer remained
   * silently replayed the first envelope forever. Every assertion still passed
   * shape-wise and none of them were testing what they said.
   */
  push(envelope: CommandEnvelope, tokens: { input?: number; output?: number } = {}): this {
    this.script.push({
      envelope,
      ...(tokens.input === undefined ? {} : { inputTokens: tokens.input }),
      ...(tokens.output === undefined ? {} : { outputTokens: tokens.output }),
    });

    return this;
  }

  interpret(input: InterpretationInput): Promise<InterpretationResult> {
    this.calls.push(input);

    const next = this.script.shift() ?? this.last;

    if (next === undefined) {
      return Promise.reject(new Error("FakeIntentInterpreter has no scripted answer."));
    }

    this.last = next;

    return Promise.resolve({
      envelope: next.envelope,
      usage: {
        provider: "fake",
        model: "fake-interpreter",
        inputTokens: next.inputTokens ?? 100,
        outputTokens: next.outputTokens ?? 20,
        estimatedCostMinor: 1,
      },
    });
  }
}

export class FakeTranscriptionProvider implements TranscriptionProvider {
  readonly calls: AudioInput[] = [];

  private readonly script: string[] = [];
  private last: string | undefined;

  push(transcript: string): this {
    this.script.push(transcript);
    return this;
  }

  transcribe(input: AudioInput): Promise<TranscriptionResult> {
    this.calls.push(input);

    const next = this.script.shift() ?? this.last;

    if (next === undefined) {
      return Promise.reject(new Error("FakeTranscriptionProvider has no scripted transcript."));
    }

    this.last = next;

    return Promise.resolve({
      transcript: next,
      detectedLanguage: input.languageHint ?? "hu",
      audioDurationMs: input.durationMs,
      usage: {
        provider: "fake",
        model: "fake-transcribe",
        audioSeconds: Math.ceil(input.durationMs / 1_000),
        estimatedCostMinor: 1,
      },
    });
  }
}

/** A provider that always fails, for the paths that must not swallow it. */
export class FailingTranscriptionProvider implements TranscriptionProvider {
  transcribe(): Promise<TranscriptionResult> {
    return Promise.reject(new Error("provider unavailable"));
  }
}

export interface FakeProviders extends AiProviders {
  transcription: FakeTranscriptionProvider;
  interpreter: FakeIntentInterpreter;
}

export function fakeProviders(): FakeProviders {
  return {
    transcription: new FakeTranscriptionProvider(),
    interpreter: new FakeIntentInterpreter(),
    composer: new TemplateResponseComposer(),
  };
}

/** A well-formed envelope, for tests that only care about one field of it. */
export function envelope(overrides: Partial<CommandEnvelope> = {}): CommandEnvelope {
  return {
    intent: "LIST_SERVICES",
    confidence: 0.95,
    parameters: {},
    missingFields: [],
    requiresConfirmation: false,
    ...overrides,
  };
}
