import OpenAI from "openai";

import { getOpenAI, type OpenAiConfig } from "./client.js";
import { audioUsage } from "./pricing.js";
import type { AudioInput, TranscriptionProvider, TranscriptionResult } from "./types.js";

/**
 * Speech to text. tech-impl §18.2, §20.
 *
 * The audio arrives as a buffer and leaves as a transcript. It is not written to
 * disk, not put in object storage and not queued — with retention off, which is
 * the default and the only setting this slice supports, there is nothing to
 * delete afterwards because nothing was ever stored
 * (docs/phase-8-push-to-talk-voice.md §4).
 *
 * Duration is measured by the caller before the call, not read back from the
 * provider: the quota gate has to know how many seconds it is about to authorise
 * *before* authorising them, and a figure that only arrives with the answer is
 * an accounting entry rather than a limit.
 */

const PROVIDER = "openai";

export class OpenAITranscriptionProvider implements TranscriptionProvider {
  constructor(private readonly config: OpenAiConfig) {}

  async transcribe(input: AudioInput): Promise<TranscriptionResult> {
    const client = getOpenAI(this.config);
    const model = this.config.transcriptionModel;
    const audioDurationMs = input.durationMs;

    const file = await OpenAI.toFile(Buffer.from(input.data), input.filename, {
      type: input.contentType,
    });

    const response = await client.audio.transcriptions.create({
      file,
      model,
      // A hint, not a constraint: an English speaker on a Hungarian booking page
      // must still be understood (types.ts, `AudioInput.languageHint`).
      ...(input.languageHint === undefined ? {} : { language: input.languageHint }),
    });

    const transcript = response.text.trim();

    // An empty transcript is a failure, not an empty utterance: the customer
    // held a button and spoke. Saying nothing back and charging for it is the
    // swallowed-failure shape this project has been bitten by before.
    if (transcript === "") throw new Error("The transcription provider returned no text.");

    return {
      transcript,
      audioDurationMs,
      usage: audioUsage({
        provider: PROVIDER,
        model,
        // Rounded up, in the tenant's favour never in ours.
        seconds: Math.ceil(audioDurationMs / 1_000),
      }),
    };
  }
}
