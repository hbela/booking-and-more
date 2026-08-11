import { AppError, ErrorCodes } from "@bam/contracts";

/**
 * Deciding whether an upload is audio we will pay to transcribe.
 * tech-impl §34.3 · docs/phase-8-push-to-talk-voice.md §3.
 *
 * Every check here is cheaper than the call it guards, and they run in
 * increasing order of cost. The rate limit on the route is cheaper still and
 * sits in front of all of them.
 */

/** The four containers a browser's MediaRecorder actually produces. */
export const ACCEPTED_AUDIO_TYPES = [
  "audio/webm",
  "audio/ogg",
  "audio/mp4",
  "audio/wav",
] as const;

export type AcceptedAudioType = (typeof ACCEPTED_AUDIO_TYPES)[number];

/**
 * What the bytes say they are, regardless of what the request said.
 *
 * A declared content type is a claim made by whoever is uploading. This is the
 * fact. They have to agree, because the provider is told the type and a
 * mislabelled container is a paid call that fails at the far end.
 */
export function sniffAudio(data: Uint8Array): AcceptedAudioType | undefined {
  const startsWith = (...bytes: number[]): boolean =>
    bytes.every((byte, index) => data[index] === byte);

  const ascii = (offset: number, text: string): boolean =>
    [...text].every((char, index) => data[offset + index] === char.charCodeAt(0));

  // Matroska/WebM EBML header.
  if (startsWith(0x1a, 0x45, 0xdf, 0xa3)) return "audio/webm";
  if (ascii(0, "OggS")) return "audio/ogg";
  // RIFF….WAVE — the format word sits after the four-byte size.
  if (ascii(0, "RIFF") && ascii(8, "WAVE")) return "audio/wav";
  // ISO base media: the box type at offset 4. Covers m4a and mp4.
  if (ascii(4, "ftyp")) return "audio/mp4";

  return undefined;
}

export interface AudioLimits {
  maxBytes: number;
  maxDurationSeconds: number;
}

export interface ValidatedAudio {
  data: Buffer;
  contentType: AcceptedAudioType;
  filename: string;
  durationMs: number;
  /** Rounded up, minimum one. What the quota gate is asked to authorise. */
  billableSeconds: number;
}

/**
 * Validate an upload, or refuse it before a penny is spent.
 *
 * ## About the duration
 *
 * It is reported by the recorder, not measured from the container. Decoding
 * four audio formats server-side to count samples would mean a native
 * dependency, in a request path whose entire purpose is to be cheap — and the
 * figure would still only be used for metering, which is bounded anyway.
 *
 * What actually bounds the spend is the pair of limits either side of this
 * claim: the byte cap here, and the per-session rate limit on the route
 * (10/minute, tech-impl §33). A client that lies about duration cannot exceed
 * ten uploads a minute of at most `maxBytes` each, whatever it claims about
 * them. A claim over the cap is refused outright, and a claim of nothing is
 * billed as one second rather than as zero.
 */
export function validateAudio(args: {
  data: Buffer;
  declaredType: string | undefined;
  filename: string | undefined;
  claimedDurationMs: number | undefined;
  limits: AudioLimits;
}): ValidatedAudio {
  if (args.data.length === 0) {
    throw audioRefused(ErrorCodes.AUDIO_FORMAT_UNSUPPORTED, "No audio was uploaded.");
  }

  if (args.data.length > args.limits.maxBytes) {
    throw audioRefused(ErrorCodes.AUDIO_TOO_LARGE, "That recording is too large.");
  }

  const declared = (args.declaredType ?? "").split(";")[0]?.trim().toLowerCase();
  const sniffed = sniffAudio(args.data);

  if (sniffed === undefined) {
    throw audioRefused(
      ErrorCodes.AUDIO_FORMAT_UNSUPPORTED,
      "That recording is not in a format we can transcribe.",
    );
  }

  // The declared type must agree with the bytes, but only where it was given —
  // some browsers send `application/octet-stream` for a Blob they themselves
  // produced, and refusing those would break recording on real devices for no
  // security gain: the sniff is what we act on either way.
  if (declared !== undefined && declared !== "" && declared !== "application/octet-stream") {
    if (declared !== sniffed) {
      throw audioRefused(
        ErrorCodes.AUDIO_FORMAT_UNSUPPORTED,
        "That recording is not in a format we can transcribe.",
      );
    }
  }

  const durationMs = args.claimedDurationMs ?? 0;
  const maxDurationMs = args.limits.maxDurationSeconds * 1_000;

  if (durationMs > maxDurationMs) {
    throw audioRefused(ErrorCodes.AUDIO_TOO_LARGE, "That recording is too long.");
  }

  return {
    data: args.data,
    contentType: sniffed,
    filename: safeFilename(args.filename, sniffed),
    durationMs,
    billableSeconds: Math.max(1, Math.ceil(durationMs / 1_000)),
  };
}

/**
 * A name for the provider's multipart part, built by us.
 *
 * The client's filename is never used: it is attacker-controlled, it reaches a
 * third party, and nothing downstream needs it. The extension has to match the
 * container or the provider rejects the upload.
 */
function safeFilename(_supplied: string | undefined, type: AcceptedAudioType): string {
  const extension = { "audio/webm": "webm", "audio/ogg": "ogg", "audio/mp4": "m4a", "audio/wav": "wav" }[
    type
  ];

  return `turn.${extension}`;
}

function audioRefused(code: typeof ErrorCodes.AUDIO_TOO_LARGE | typeof ErrorCodes.AUDIO_FORMAT_UNSUPPORTED, message: string): AppError {
  // 422 rather than 400: the request is well formed, its content is not what
  // this endpoint accepts. `report: false` — a customer on an odd browser is
  // not an incident.
  return new AppError(code, message, { statusCode: 422, report: false });
}
