import { Permissions } from "@bam/auth";
import { commonErrorResponses, idSchema, languageSchema } from "@bam/contracts";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  assistantFaqInputSchema,
  assistantFaqSchema,
  assistantSettingsInputSchema,
  assistantSettingsSchema,
  conversationDetailSchema,
  conversationListItemSchema,
  conversationListQuerySchema,
  conversationStatsSchema,
} from "./assistant.schemas.js";
import { AssistantService } from "./assistant.service.js";

export const assistantRoutes: FastifyPluginAsyncZod = async (app) => {
  const service = new AssistantService(app.prisma);
  const entitled = async (request: { tenant?: { id: string } }) =>
    service.assertEntitled(request.tenant!.id);
  const manage = [
    app.requireWritableTenant,
    app.requirePermission(Permissions.ASSISTANT_MANAGE),
    entitled,
  ];
  const read = [app.requirePermission(Permissions.CONVERSATION_READ_ALL), entitled];

  app.get(
    "/settings",
    {
      preHandler: read,
      schema: {
        tags: ["assistant"],
        response: { 200: assistantSettingsSchema, ...commonErrorResponses },
      },
    },
    async (request) => {
      const tenant = request.tenant!;
      const row = await service.getSettings(tenant.id);
      return row
        ? toSettings(row)
        : {
            tenantId: tenant.id,
            enabled: false,
            personaName: "Assistant",
            businessDescription: null,
            supportedLocales: [languageSchema.parse(tenant.defaultLanguage)],
            escalationMessage: null,
            updatedAt: new Date(0).toISOString(),
          };
    },
  );

  app.patch(
    "/settings",
    {
      preHandler: manage,
      schema: {
        tags: ["assistant"],
        body: assistantSettingsInputSchema,
        response: { 200: assistantSettingsSchema, ...commonErrorResponses },
      },
    },
    async (request) => {
      const tenantId = request.tenant!.id;
      const row = await service.saveSettings(tenantId, request.body);
      request.audit({
        action: "assistant.settings.updated",
        entityType: "TenantAssistantSettings",
        entityId: tenantId,
      });
      return toSettings(row);
    },
  );

  app.get(
    "/faqs",
    {
      preHandler: read,
      schema: {
        tags: ["assistant"],
        response: {
          200: z.object({ items: z.array(assistantFaqSchema) }),
          ...commonErrorResponses,
        },
      },
    },
    async (request) => ({ items: (await service.listFaqs(request.tenant!.id)).map(toFaq) }),
  );

  app.post(
    "/faqs",
    {
      preHandler: manage,
      schema: {
        tags: ["assistant"],
        body: assistantFaqInputSchema,
        response: { 201: assistantFaqSchema, ...commonErrorResponses },
      },
    },
    async (request, reply) => {
      const row = await service.createFaq(request.tenant!.id, request.body);
      request.audit({
        action: "assistant.faq.created",
        entityType: "TenantAssistantFaq",
        entityId: row.id,
      });
      return reply.status(201).send(toFaq(row));
    },
  );

  app.put(
    "/faqs/:id",
    {
      preHandler: manage,
      schema: {
        tags: ["assistant"],
        params: z.object({ id: idSchema }),
        body: assistantFaqInputSchema,
        response: { 200: assistantFaqSchema, ...commonErrorResponses },
      },
    },
    async (request) =>
      toFaq(await service.updateFaq(request.tenant!.id, request.params.id, request.body)),
  );

  app.delete(
    "/faqs/:id",
    {
      preHandler: manage,
      schema: {
        tags: ["assistant"],
        params: z.object({ id: idSchema }),
        response: { 204: z.null(), ...commonErrorResponses },
      },
    },
    async (request, reply) => {
      await service.deleteFaq(request.tenant!.id, request.params.id);
      request.audit({
        action: "assistant.faq.deleted",
        entityType: "TenantAssistantFaq",
        entityId: request.params.id,
      });
      return reply.status(204).send(null);
    },
  );

  app.get(
    "/conversations",
    {
      preHandler: read,
      schema: {
        tags: ["assistant"],
        querystring: conversationListQuerySchema,
        response: {
          200: z.object({ items: z.array(conversationListItemSchema) }),
          ...commonErrorResponses,
        },
      },
    },
    async (request) => ({
      items: (await service.listConversations(request.tenant!.id, request.query)).map(
        toConversation,
      ),
    }),
  );

  app.get(
    "/conversations/stats",
    {
      preHandler: read,
      schema: {
        tags: ["assistant"],
        response: { 200: conversationStatsSchema, ...commonErrorResponses },
      },
    },
    async (request) => service.stats(request.tenant!.id),
  );

  app.get(
    "/conversations/:id",
    {
      preHandler: read,
      schema: {
        tags: ["assistant"],
        params: z.object({ id: idSchema }),
        response: { 200: conversationDetailSchema, ...commonErrorResponses },
      },
    },
    async (request) => {
      const row = await service.conversation(request.tenant!.id, request.params.id);
      return {
        ...toConversation(row),
        summary: row.summary,
        messages: row.messages.map((message) => ({
          id: message.id,
          sender: message.sender,
          content: message.content,
          structured: message.structuredContentJson,
          createdAt: message.createdAt.toISOString(),
        })),
      };
    },
  );
};

function toFaq(row: {
  id: string;
  locale: string;
  question: string;
  answer: string;
  active: boolean;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    ...row,
    locale: languageSchema.parse(row.locale),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
function toSettings(row: {
  tenantId: string;
  enabled: boolean;
  personaName: string;
  businessDescription: string | null;
  supportedLocales: string[];
  escalationMessage: string | null;
  updatedAt: Date;
}) {
  return {
    ...row,
    supportedLocales: row.supportedLocales.map((locale) => languageSchema.parse(locale)),
    updatedAt: row.updatedAt.toISOString(),
  };
}
function toConversation(row: {
  id: string;
  locale: string;
  status: string;
  turnCount: number;
  outcomeSuccessful: boolean | null;
  bookingId: string | null;
  customerId: string | null;
  createdAt: Date;
  lastActivityAt: Date;
}) {
  return {
    id: row.id,
    locale: row.locale,
    status: row.status,
    turnCount: row.turnCount,
    outcomeSuccessful: row.outcomeSuccessful,
    bookingId: row.bookingId,
    customerId: row.customerId,
    startedAt: row.createdAt.toISOString(),
    lastActivityAt: row.lastActivityAt.toISOString(),
  };
}
