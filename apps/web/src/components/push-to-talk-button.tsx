"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Mic, Square } from "lucide-react";

/**
 * The microphone. tech-impl §19 · PRD §8.3, §9.11, §10.1.
 *
 * ## It is a button, not a gesture
 *
 * "Push to talk" describes the interaction, not the implementation. A
 * press-and-hold gesture has no keyboard equivalent, so this is a toggle: press
 * to start, press to stop, Escape to abandon. A customer using a keyboard or a
 * switch loses nothing, which is the accessibility requirement in PRD §12.4 and
 * not a compromise.
 *
 * ## What it does not do
 *
 * It does not upload, does not transcribe and does not know what a conversation
 * is. It hands its parent a `Blob` and a duration. Recording is a browser
 * concern; everything after it is the panel's.
 */

/** tech-impl §19.1, implemented as written. */
export type RecordingState =
  | "IDLE"
  | "REQUESTING_PERMISSION"
  | "RECORDING"
  | "UPLOADING"
  | "TRANSCRIBING"
  | "REVIEWING"
  | "PROCESSING"
  | "ERROR";

export interface PushToTalkProps {
  /** Set by the panel while it is uploading, transcribing or thinking. */
  state: RecordingState;
  onStateChange: (state: RecordingState) => void;
  onRecorded: (audio: Blob, durationMs: number) => void;
  onError: (messageKey: string) => void;
  /** From the server's VOICE_MAX_DURATION_SECONDS. */
  maxDurationSeconds: number;
  disabled?: boolean;
}

/**
 * Can this browser record at all?
 *
 * tech-impl §19.3: when it cannot, the microphone is not rendered — the chat
 * input stays and the form stays. Nothing on the page announces a capability
 * that is not there.
 */
export function canRecord(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.MediaRecorder !== "undefined" &&
    typeof navigator.mediaDevices?.getUserMedia === "function"
  );
}

/** The first container this browser will actually produce. */
function pickMimeType(): string | undefined {
  const candidates = ["audio/webm", "audio/ogg", "audio/mp4"];

  return candidates.find((type) => MediaRecorder.isTypeSupported(type));
}

export function PushToTalkButton({
  state,
  onStateChange,
  onRecorded,
  onError,
  maxDurationSeconds,
  disabled = false,
}: PushToTalkProps): React.ReactElement {
  const t = useTranslations("conversation");

  const recorder = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const startedAt = useRef<number>(0);
  const abandoned = useRef(false);
  const [elapsed, setElapsed] = useState(0);

  const stopTracks = useCallback((): void => {
    recorder.current?.stream.getTracks().forEach((track) => {
      track.stop();
    });
    recorder.current = null;
  }, []);

  const stop = useCallback((): void => {
    if (recorder.current?.state === "recording") recorder.current.stop();
  }, []);

  /** Throw the recording away. Nothing is uploaded, so nothing is charged. */
  const abandon = useCallback((): void => {
    abandoned.current = true;
    stop();
    onStateChange("IDLE");
  }, [onStateChange, stop]);

  const start = useCallback(async (): Promise<void> => {
    if (!canRecord()) {
      onError("error.noMicrophone");
      return;
    }

    onStateChange("REQUESTING_PERMISSION");

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      // Denied, dismissed, or no device. All three are the same to us: the
      // customer types instead.
      onStateChange("IDLE");
      onError("error.microphoneDenied");
      return;
    }

    const mimeType = pickMimeType();
    const instance = new MediaRecorder(stream, mimeType === undefined ? {} : { mimeType });

    chunks.current = [];
    abandoned.current = false;
    startedAt.current = Date.now();
    recorder.current = instance;

    instance.addEventListener("dataavailable", (event) => {
      if (event.data.size > 0) chunks.current.push(event.data);
    });

    instance.addEventListener("stop", () => {
      const durationMs = Date.now() - startedAt.current;
      const blob = new Blob(chunks.current, { type: mimeType ?? "audio/webm" });

      stopTracks();
      setElapsed(0);

      if (abandoned.current) return;

      // A tap rather than an utterance. Uploading it would cost a request and
      // return an empty transcript, which reads to the customer as the
      // assistant ignoring them.
      if (durationMs < 400 || blob.size === 0) {
        onStateChange("IDLE");
        onError("error.tooShort");
        return;
      }

      onRecorded(blob, durationMs);
    });

    instance.start();
    onStateChange("RECORDING");
  }, [onError, onRecorded, onStateChange, stopTracks]);

  // The elapsed counter, and the cap that stops it. A customer who forgets to
  // press stop must not discover the limit as a rejected upload.
  useEffect(() => {
    if (state !== "RECORDING") return;

    const timer = setInterval(() => {
      const seconds = Math.floor((Date.now() - startedAt.current) / 1_000);
      setElapsed(seconds);

      if (seconds >= maxDurationSeconds) stop();
    }, 250);

    return () => {
      clearInterval(timer);
    };
  }, [maxDurationSeconds, state, stop]);

  // Escape abandons. Bound only while recording, so it does not fight anything
  // else on the page for the key.
  useEffect(() => {
    if (state !== "RECORDING") return;

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") abandon();
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [abandon, state]);

  // Releasing the microphone when the panel goes away matters: a stream left
  // open keeps the browser's recording indicator lit, which reads as the page
  // still listening.
  useEffect(() => stopTracks, [stopTracks]);

  const busy = state === "UPLOADING" || state === "TRANSCRIBING" || state === "PROCESSING";
  const recording = state === "RECORDING";

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        disabled={disabled || busy || state === "REQUESTING_PERMISSION"}
        aria-pressed={recording}
        aria-label={recording ? t("voice.stop") : t("voice.start")}
        onClick={() => {
          if (recording) {
            stop();
            return;
          }
          void start();
        }}
        className={
          recording
            ? "flex h-11 w-11 items-center justify-center rounded-full bg-red-600 text-white"
            : "flex h-11 w-11 items-center justify-center rounded-full border border-slate-300 hover:border-brand-600 disabled:opacity-50 dark:border-slate-700"
        }
      >
        {recording ? <Square size={18} aria-hidden /> : <Mic size={18} aria-hidden />}
      </button>

      {recording ? (
        <span className="text-sm tabular-nums text-red-600 dark:text-red-400" role="status">
          {t("voice.recording", { elapsed, max: maxDurationSeconds })}
        </span>
      ) : null}

      {recording ? (
        <button
          type="button"
          onClick={abandon}
          className="text-sm underline text-slate-600 dark:text-slate-400"
        >
          {t("voice.discard")}
        </button>
      ) : null}
    </div>
  );
}

/**
 * Speak a reply, if the device can and the customer has not turned it off.
 *
 * `window.speechSynthesis` only — PRD §10.5 and §11 both point at device TTS,
 * and a paid provider is explicitly out of this slice. Every reply is on screen
 * first (PRD §4.4), so this is an addition to the interface and never the
 * interface itself.
 */
export function speak(text: string, locale: string): void {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return;

  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = locale === "hu" ? "hu-HU" : "en-GB";

  // Cancel anything still speaking: two overlapping replies are worse than a
  // truncated one.
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(utterance);
}
