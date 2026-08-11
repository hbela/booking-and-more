import multipart from "@fastify/multipart";
import type { AiProviders } from "@bam/ai";
import { AppError, ErrorCodes, commonErrorResponses } from "@bam/contracts";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";

import { validateAudio } from "./audio.js";

import { requireIdempotencyKey } from "../../lib/idempotency.js";
import { auditContextOf } from "../bookings/booking.routes.js";
import { idempotencyHeaderSchema } from "../bookings/booking.schemas.js";
import { tenantSlugParamsSchema } from "./catalogue.schemas.js";
import { PublicCatalogueService } from "./catalogue.service.js";
import {
  actionParamsSchema,
  conversationCreatedSchema,
  conversationParamsSchema,
  conversationStateSchema,
  conversationTokenHeaderSchema,
  conversationTurnSchema,
  createConversationBodySchema,
  sendMessageBodySchema,
} from "./conversation.schemas.js";
import { ConversationService, type ConversationOptions } from "./conversation.service.js";

/**
 * Chat and voice, for people with no account.
 * tech-impl §18 · docs/phase-7-chat-booking.md §2.
 *
 * ## Why these are not `/v1/voice/*`
 *
 * tech-impl §18 and PRD §19.3 name them that. Both are overruled, and phase-7 §2
 * records why: this is an unauthenticated surface, so rule 12 puts it under
 * `modules/public/` with its own response schemas; and it is named after the
 * conversation rather than after one of its two transports, because the
 * chat-only path is the larger one and works without a microphone.
 *
 * ## What authorises these requests
 *
 * Creating a conversation: nothing, as with a hold. Everything afterwards: an
 * opaque session token, 32 random bytes, stored only as a SHA-256 hash, carried
 * in `X-Conversation-Token`. Every way it can fail returns one 404.
 */
export interface ConversationRoutesOptions {
  providers: AiProviders;
  conversation: ConversationOptions;
  audio: { maxBytes: number; maxDurationSeconds: number };
}

export const publicConversationRoutes: FastifyPluginAsyncZod<ConversationRoutesOptions> = async (
  app,
  options,
) => {
  const catalogue = new PublicCatalogueService(app.prisma);
  const conversations = new ConversationService(
    app.prisma,
    options.providers,
    options.conversation,
  );

  /** A turn costs a model call. Tighter than the catalogue's 120/min. */
  const turnRateLimit = { rateLimit: { max: 20, timeWindow: "1 minute" } };
  /** Starting one is rarer still, and each start mints a credential. */
  const startRateLimit = { rateLimit: { max: 10, timeWindow: "1 minute" } };

  /** The header, then the row. Both must agree or it is a 404. */
  async function fromRequest(request: {
    params: { conversationId: string };
    headers: { "x-conversation-token": string };
  }) {
    return conversations.resolve({
      conversationId: request.params.conversationId,
      token: request.headers["x-conversation-token"],
    });
  }

  app.post(
    "/tenants/:tenantSlug/conversations",
    {
      config: startRateLimit,
      schema: {
        tags: ["public"],
        summary: "Start a conversation with the booking assistant",
        description:
          "Returns the session token once and only once — it is stored as a hash and cannot be reissued.",
        params: tenantSlugParamsSchema,
        body: createConversationBodySchema,
        response: { 201: conversationCreatedSchema, ...commonErrorResponses },
      },
    },
    async (request, reply) => {
      const tenant = await catalogue.resolveTenant(request.params.tenantSlug);

      const started = await conversations.start({
        tenant,
        input: request.body,
        now: new Date(),
      });

      return reply.status(201).send({
        ...started.response,
        sessionToken: started.token,
        expiresAt: started.expiresAt.toISOString(),
      });
    },
  );

  app.get(
    "/conversations/:conversationId",
    {
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
      schema: {
        tags: ["public"],
        summary: "Replay a conversation",
        description: "What the panel calls after a page refresh. Epic 7's state-survives-refresh.",
        params: conversationParamsSchema,
        headers: conversationTokenHeaderSchema,
        response: { 200: conversationStateSchema, ...commonErrorResponses },
      },
    },
    async (request) => {
      const { session, tenant } = await fromRequest(request);
      return conversations.replay({ session, tenant });
    },
  );

  app.post(
    "/conversations/:conversationId/messages",
    {
      config: turnRateLimit,
      schema: {
        tags: ["public"],
        summary: "Say something to the assistant",
        description:
          "The same endpoint for typed text and for a reviewed transcript — voice is a transport, not a mode.",
        params: conversationParamsSchema,
        headers: conversationTokenHeaderSchema,
        body: sendMessageBodySchema,
        response: { 200: conversationTurnSchema, ...commonErrorResponses },
      },
    },
    async (request) => {
      const { session, tenant } = await fromRequest(request);

      return conversations.message({
        session,
        tenant,
        text: request.body.text,
        spoken: request.body.spoken,
        now: new Date(),
      });
    },
  );

  // Only this plugin accepts a file, so the parser is registered here rather
  // than in the composition root: no other route should silently gain the
  // ability to receive one. The API's 1 MiB `bodyLimit` does not apply to
  // multipart parts, so `fileSize` is the cap that counts (tech-impl §34.3).
  await app.register(multipart, {
    limits: { fileSize: options.audio.maxBytes, files: 1, fields: 4 },
  });

  app.post(
    "/conversations/:conversationId/transcriptions",
    {
      // tech-impl §33: 10 per minute, per session.
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
      schema: {
        tags: ["public"],
        summary: "Transcribe one recording",
        description:
          "Returns the transcript and stops. It does not interpret, does not run a tool and does not move the conversation — the customer reviews what was heard first (PRD §10.1).",
        consumes: ["multipart/form-data"],
        params: conversationParamsSchema,
        headers: conversationTokenHeaderSchema,
        response: {
          200: z.object({
            transcript: z.string(),
            durationMs: z.number().int().min(0),
            detectedLanguage: z.string().nullable(),
          }),
          ...commonErrorResponses,
        },
      },
    },
    async (request) => {
      const { session, tenant } = await fromRequest(request);

      const part = await request.file();

      if (part === undefined) {
        throw new AppError(ErrorCodes.AUDIO_FORMAT_UNSUPPORTED, "No audio was uploaded.", {
          statusCode: 422,
          report: false,
        });
      }

      // Buffered rather than streamed to the provider: the validations below
      // have to see the first bytes, and 5 MB is a bound we set rather than one
      // we hope for.
      const data = await part.toBuffer();

      const audio = validateAudio({
        data,
        declaredType: part.mimetype,
        filename: part.filename,
        claimedDurationMs: durationFrom(part.fields),
        limits: options.audio,
      });

      return conversations.transcribe({ session, tenant, audio, now: new Date() });
    },
  );

  app.post(
    "/conversations/:conversationId/actions/:actionId/confirm",
    {
      config: turnRateLimit,
      schema: {
        tags: ["public"],
        summary: "Confirm a named pending action",
        description:
          "There is no endpoint meaning 'confirm whatever we were discussing'. The action id is in the path (tech-impl §22.1).",
        params: actionParamsSchema,
        headers: conversationTokenHeaderSchema.merge(idempotencyHeaderSchema),
        response: { 200: conversationTurnSchema, ...commonErrorResponses },
      },
    },
    async (request) => {
      const { session, tenant } = await fromRequest(request);

      return conversations.confirm({
        session,
        tenant,
        actionId: request.params.actionId,
        idempotencyKey: requireIdempotencyKey(request.headers),
        audit: auditContextOf(request),
        now: new Date(),
      });
    },
  );

  app.post(
    "/conversations/:conversationId/actions/:actionId/cancel",
    {
      config: turnRateLimit,
      schema: {
        tags: ["public"],
        summary: "Withdraw a pending action",
        params: actionParamsSchema,
        headers: conversationTokenHeaderSchema,
        response: { 200: conversationTurnSchema, ...commonErrorResponses },
      },
    },
    async (request) => {
      const { session, tenant } = await fromRequest(request);

      return conversations.cancelAction({
        session,
        tenant,
        actionId: request.params.actionId,
        now: new Date(),
      });
    },
  );
};

/**
 * The recorder's own measurement, if it sent one.
 *
 * Untrusted, and treated as such: `validateAudio` refuses a claim over the cap
 * and bills a missing one as a second rather than as nothing. See its comment
 * for why the figure is not measured server-side.
 */
function durationFrom(fields: unknown): number | undefined {
  if (typeof fields !== "object" || fields === null) return undefined;

  const field = (fields as Record<string, unknown>)["durationMs"];

  if (typeof field !== "object" || field === null || !("value" in field)) return undefined;

  const parsed = Number(field.value);

  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}
