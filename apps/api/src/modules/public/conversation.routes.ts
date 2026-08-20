import { conversationUnavailable, type AiProviders } from "@bam/ai";
import { commonErrorResponses } from "@bam/contracts";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";

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
import { AssistantService } from "../assistant/assistant.service.js";
import { publicAssistantSchema } from "../assistant/assistant.schemas.js";

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
  configured: boolean;
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
  const assistant = new AssistantService(app.prisma);

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

  app.get(
    "/tenants/:tenantSlug/assistant",
    {
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
      schema: {
        tags: ["public"],
        summary: "Read the tenant's public assistant availability",
        params: tenantSlugParamsSchema,
        response: { 200: publicAssistantSchema, ...commonErrorResponses },
      },
    },
    async (request) => {
      const tenant = await catalogue.resolveTenant(request.params.tenantSlug);
      const result = await assistant.publicConfig(tenant);
      return { ...result, available: result.available && options.configured };
    },
  );

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
      const availability = await assistant.publicConfig(tenant);
      if (!options.configured || !availability.available) throw conversationUnavailable();

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
        response: { ...commonErrorResponses },
      },
    },
    async (request, reply) => {
      const { session, tenant } = await fromRequest(request);

      const turn = await conversations.message({
        session,
        tenant,
        text: request.body.text,
        spoken: false,
        now: new Date(),
      });

      // `hijack()` bypasses Fastify's normal send path, including the point
      // where CORS and security headers are copied onto the Node response.
      // Preserve everything the registered hooks prepared before taking over
      // the stream, or browsers receive the events and still reject `fetch()`.
      for (const [name, value] of Object.entries(reply.getHeaders())) {
        if (value !== undefined) reply.raw.setHeader(name, value);
      }
      reply.hijack();
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      const emit = (event: string, data: unknown): void => {
        reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };
      emit("text_delta", { text: turn.message });
      if (turn.services || turn.providers || turn.slots) {
        emit("tool_activity", {
          services: turn.services,
          providers: turn.providers,
          slots: turn.slots,
        });
      }
      if (turn.confirmation) emit("pending_action", turn.confirmation);
      emit("completion", turn);
      reply.raw.end();
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
