import { conversationUnavailable } from "./client.js";
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

export class DisabledTranscriptionProvider implements TranscriptionProvider {
  transcribe(_input: AudioInput): Promise<TranscriptionResult> {
    return Promise.reject(conversationUnavailable());
  }
}
