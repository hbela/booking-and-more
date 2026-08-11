import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fakeProviders, type FakeProviders } from "@bam/ai";
import { loadEnv } from "@bam/config";

import { buildApp, type AppInstance } from "./app.js";
import { sniffAudio, validateAudio } from "./modules/public/audio.js";

/**
 * Epic 8's server half. docs/phase-8-push-to-talk-voice.md.
 *
 * The transcription provider is scripted, so what is under test is the six
 * checks that run before it — every one of which is cheaper than the call it
 * guards — and the two facts that follow the call: the seconds are metered, and
 * the row that records them says the audio was not retained.
 */

const databaseUrl = process.env["TEST_DATABASE_URL"];

const RUN = `vc${randomBytes(4).toString("hex")}`;

/** A minimal but genuine container header of each kind. */
const HEADERS = {
  webm: Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x00, 0x00, 0x00, 0x00]),
  ogg: Buffer.concat([Buffer.from("OggS"), Buffer.alloc(4)]),
  wav: Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WAVE")]),
  mp4: Buffer.concat([Buffer.alloc(4), Buffer.from("ftypM4A ")]),
};

function recording(kind: keyof typeof HEADERS = "webm", bytes = 2_048): Buffer {
  return Buffer.concat([HEADERS[kind], randomBytes(bytes)]);
}

/** A multipart body, hand-rolled — there is no client library in this suite. */
function multipart(args: {
  audio: Buffer;
  contentType?: string;
  filename?: string;
  durationMs?: number;
}): { payload: Buffer; headers: Record<string, string> } {
  const boundary = `----bam${randomBytes(8).toString("hex")}`;
  const parts: Buffer[] = [];

  if (args.durationMs !== undefined) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="durationMs"\r\n\r\n${args.durationMs}\r\n`,
      ),
    );
  }

  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="audio"; filename="${args.filename ?? "turn.webm"}"\r\nContent-Type: ${args.contentType ?? "audio/webm"}\r\n\r\n`,
    ),
    args.audio,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  );

  return {
    payload: Buffer.concat(parts),
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
  };
}

describe("audio validation", () => {
  it("recognises every container a browser produces", () => {
    expect(sniffAudio(HEADERS.webm)).toBe("audio/webm");
    expect(sniffAudio(HEADERS.ogg)).toBe("audio/ogg");
    expect(sniffAudio(HEADERS.wav)).toBe("audio/wav");
    expect(sniffAudio(HEADERS.mp4)).toBe("audio/mp4");
  });

  it("believes the bytes rather than the header", () => {
    // A declared type is a claim made by whoever is uploading.
    expect(sniffAudio(Buffer.from("GIF89a and then some"))).toBeUndefined();

    expect(() =>
      validateAudio({
        data: Buffer.from("GIF89a and then some"),
        declaredType: "audio/webm",
        filename: "turn.webm",
        claimedDurationMs: 3_000,
        limits: { maxBytes: 5_000_000, maxDurationSeconds: 30 },
      }),
    ).toThrow(/format/iu);
  });

  it("refuses a mislabelled container", () => {
    expect(() =>
      validateAudio({
        data: recording("ogg"),
        declaredType: "audio/wav",
        filename: "turn.wav",
        claimedDurationMs: 3_000,
        limits: { maxBytes: 5_000_000, maxDurationSeconds: 30 },
      }),
    ).toThrow();
  });

  it("accepts the octet-stream some browsers send for their own Blob", () => {
    const validated = validateAudio({
      data: recording("webm"),
      declaredType: "application/octet-stream",
      filename: "blob",
      claimedDurationMs: 3_000,
      limits: { maxBytes: 5_000_000, maxDurationSeconds: 30 },
    });

    expect(validated.contentType).toBe("audio/webm");
  });

  it("never passes the client's filename on to the provider", () => {
    const validated = validateAudio({
      data: recording("ogg"),
      declaredType: "audio/ogg",
      filename: "../../etc/passwd",
      claimedDurationMs: 1_000,
      limits: { maxBytes: 5_000_000, maxDurationSeconds: 30 },
    });

    expect(validated.filename).toBe("turn.ogg");
  });

  it("refuses a recording over either cap", () => {
    const limits = { maxBytes: 4_096, maxDurationSeconds: 30 };

    expect(() =>
      validateAudio({
        data: recording("webm", 8_192),
        declaredType: "audio/webm",
        filename: "turn.webm",
        claimedDurationMs: 3_000,
        limits,
      }),
    ).toThrow(/large/iu);

    expect(() =>
      validateAudio({
        data: recording("webm", 512),
        declaredType: "audio/webm",
        filename: "turn.webm",
        claimedDurationMs: 45_000,
        limits,
      }),
    ).toThrow(/long/iu);
  });

  it("bills a missing duration as a second rather than as nothing", () => {
    const validated = validateAudio({
      data: recording(),
      declaredType: "audio/webm",
      filename: "turn.webm",
      claimedDurationMs: undefined,
      limits: { maxBytes: 5_000_000, maxDurationSeconds: 30 },
    });

    expect(validated.billableSeconds).toBe(1);
  });

  it("rounds a partial second up, in the tenant's favour never ours", () => {
    const validated = validateAudio({
      data: recording(),
      declaredType: "audio/webm",
      filename: "turn.webm",
      claimedDurationMs: 4_100,
      limits: { maxBytes: 5_000_000, maxDurationSeconds: 30 },
    });

    expect(validated.billableSeconds).toBe(5);
  });
});

describe.skipIf(!databaseUrl)("transcription", () => {
  let app: AppInstance;
  let ai: FakeProviders;
  let tenantId: string;
  let slug: string;

  beforeAll(async () => {
    const env = loadEnv({
      source: {
        NODE_ENV: "test",
        LOG_LEVEL: "silent",
        APP_BASE_URL: "http://localhost:3000",
        API_BASE_URL: "http://localhost:3001",
        DATABASE_URL: databaseUrl!,
        BETTER_AUTH_SECRET: "test-secret-that-is-at-least-32-characters-long",
      },
      loadDotenvFile: false,
    });

    ai = fakeProviders();
    app = await buildApp({ env, logger: false, rateLimit: false, aiProviders: ai });
    await app.ready();

    slug = `voice-${RUN}`;
    const tenant = await app.prisma.tenant.create({
      data: { slug, name: "Voice clinic", status: "ACTIVE", defaultLanguage: "hu" },
    });
    tenantId = tenant.id;
  });

  afterAll(async () => {
    const where = { tenantId };
    await app.prisma.voiceInteraction.deleteMany({ where });
    await app.prisma.conversationMessage.deleteMany({ where });
    await app.prisma.conversationPendingAction.deleteMany({ where });
    await app.prisma.conversationSession.deleteMany({ where });
    await app.prisma.usageEvent.deleteMany({ where });
    await app.prisma.usageAggregate.deleteMany({ where });
    await app.prisma.tenant.delete({ where: { id: tenantId } });
    await app.close();
  });

  async function conversation() {
    const response = await app.inject({
      method: "POST",
      url: `/v1/public/tenants/${slug}/conversations`,
      payload: { channel: "VOICE", locale: "hu", timezone: "Europe/Budapest" },
    });

    expect(response.statusCode, response.body).toBe(201);
    const body = response.json<{ conversationId: string; sessionToken: string }>();

    return {
      id: body.conversationId,
      headers: { "x-conversation-token": body.sessionToken },
    };
  }

  async function upload(
    session: { id: string; headers: Record<string, string> },
    options: Parameters<typeof multipart>[0],
  ) {
    const body = multipart(options);

    return app.inject({
      method: "POST",
      url: `/v1/public/conversations/${session.id}/transcriptions`,
      headers: { ...session.headers, ...body.headers },
      payload: body.payload,
    });
  }

  it("returns the transcript and stops", async () => {
    const session = await conversation();
    ai.transcription.push("holnap délután szeretnék jönni");

    const response = await upload(session, { audio: recording(), durationMs: 4_000 });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json<{ transcript: string }>().transcript).toBe(
      "holnap délután szeretnék jönni",
    );

    // It did not interpret, did not run a tool and did not move the state
    // (PRD §10.1). The customer reviews the transcript first.
    const row = await app.prisma.conversationSession.findUniqueOrThrow({
      where: { id: session.id },
    });
    expect(row.machineState).toBe("START");
    expect(row.turnCount).toBe(0);
    expect(ai.interpreter.calls).toHaveLength(0);
  });

  it("tells the provider which language the page is in, as a hint", async () => {
    const session = await conversation();
    ai.transcription.push("igen");

    await upload(session, { audio: recording(), durationMs: 1_000 });

    expect(ai.transcription.calls.at(-1)?.languageHint).toBe("hu");
  });

  it("records the interaction and says the audio was not kept", async () => {
    const session = await conversation();
    ai.transcription.push("jövő kedden");

    await upload(session, { audio: recording(), durationMs: 6_000 });

    const interaction = await app.prisma.voiceInteraction.findFirstOrThrow({
      where: { tenantId, sessionId: session.id },
    });

    expect(interaction.audioDurationMs).toBe(6_000);
    expect(interaction.transcript).toBe("jövő kedden");
    // Retention is off, so nothing was stored to retain.
    expect(interaction.audioRetained).toBe(false);
  });

  it("meters the seconds against the tenant", async () => {
    const session = await conversation();
    ai.transcription.push("valamit mondtam");

    await upload(session, { audio: recording(), durationMs: 7_400 });

    const aggregate = await app.prisma.usageAggregate.findFirstOrThrow({
      where: { tenantId, category: "VOICE_TRANSCRIPTION" },
    });

    // Rounded up: 7.4 seconds is charged as 8.
    expect(aggregate.quantity).toBeGreaterThanOrEqual(8);
  });

  it("refuses a recording that is not audio before paying for it", async () => {
    const session = await conversation();
    const before = ai.transcription.calls.length;

    const response = await upload(session, {
      audio: Buffer.from("GIF89a definitely not audio"),
      contentType: "audio/webm",
      durationMs: 3_000,
    });

    expect(response.statusCode).toBe(422);
    expect(response.json<{ error: { code: string } }>().error.code).toBe(
      "AUDIO_FORMAT_UNSUPPORTED",
    );
    expect(ai.transcription.calls).toHaveLength(before);
  });

  it("refuses a recording longer than the cap", async () => {
    const session = await conversation();

    const response = await upload(session, { audio: recording(), durationMs: 60_000 });

    expect(response.statusCode).toBe(422);
    expect(response.json<{ error: { code: string } }>().error.code).toBe("AUDIO_TOO_LARGE");
  });

  it("needs the session token like every other conversational route", async () => {
    const session = await conversation();
    const body = multipart({ audio: recording(), durationMs: 2_000 });

    const response = await app.inject({
      method: "POST",
      url: `/v1/public/conversations/${session.id}/transcriptions`,
      headers: { "x-conversation-token": randomBytes(32).toString("base64url"), ...body.headers },
      payload: body.payload,
    });

    expect(response.statusCode).toBe(404);
  });
});
