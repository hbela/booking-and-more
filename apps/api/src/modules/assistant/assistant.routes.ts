import { Permissions } from "@bam/auth";
import type { KnowledgeAssistant } from "@bam/ai";
import {
  acknowledgeKnowledgeFindingSchema,
  commonErrorResponses,
  idSchema,
  knowledgeAuditRequestSchema,
  knowledgeAuditSchema,
  knowledgeHealthSchema,
  languageSchema,
  translationDraftRequestSchema,
  translationDraftSchema,
} from "@bam/contracts";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  assistantFaqInputSchema,
  assistantFaqSchema,
  assistantSettingsPatchSchema,
  assistantSettingsSchema,
  conversationDetailSchema,
  conversationListItemSchema,
  conversationListQuerySchema,
  conversationStatsSchema,
  groundingWarningsSchema,
} from "./assistant.schemas.js";
import { AssistantService } from "./assistant.service.js";
import { KnowledgeAiService, type KnowledgeAiLimits } from "./knowledge-ai.service.js";
import { acknowledgeFinding, knowledgeHealth, removeAcknowledgement } from "./knowledge-health.js";

export interface AssistantRouteOptions {
  /** phase-12 part 4. Anthropic in production, a scripted fake in tests. */
  knowledgeAssistant: KnowledgeAssistant;
  knowledgeAiLimits: KnowledgeAiLimits;
}

export const assistantRoutes: FastifyPluginAsyncZod<AssistantRouteOptions> = async (
  app,
  options,
) => {
  const service = new AssistantService(app.prisma);
  const knowledgeAi = new KnowledgeAiService(
    app.prisma,
    options.knowledgeAssistant,
    options.knowledgeAiLimits,
  );
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
            personaName: tenant.defaultLanguage === "hu" ? "Asszisztens" : "Assistant",
            businessDescription: null,
            businessDescriptionHu: null,
            businessDescriptionEn: null,
            businessDescriptionDe: null,
            businessDescriptionFr: null,
            supportedLocales: [...languageSchema.options],
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
        body: assistantSettingsPatchSchema,
        response: { 200: assistantSettingsSchema, ...commonErrorResponses },
      },
    },
    async (request) => {
      const tenantId = request.tenant!.id;
      const row = await service.saveSettings(
        tenantId,
        request.body,
        request.tenant!.defaultLanguage,
      );
      request.audit({
        action: "assistant.settings.updated",
        entityType: "TenantAssistantSettings",
        entityId: tenantId,
      });
      return toSettings(row);
    },
  );

  // phase-12 §3.1, §5.1: where the profile, service descriptions and FAQs
  // contradict the records. Read-only, computed on every request.
  app.get(
    "/knowledge/health",
    {
      preHandler: read,
      schema: {
        tags: ["assistant"],
        response: { 200: knowledgeHealthSchema, ...commonErrorResponses },
      },
    },
    async (request) => knowledgeHealth(app.prisma, request.tenant!.id),
  );

  // phase-12 §3.3: the owner marks a finding as intended. Both return the
  // recomputed health, so the screen and the enable gate agree immediately.
  app.post(
    "/knowledge/acknowledgements",
    {
      preHandler: manage,
      schema: {
        tags: ["assistant"],
        body: acknowledgeKnowledgeFindingSchema,
        response: { 201: knowledgeHealthSchema, ...commonErrorResponses },
      },
    },
    async (request, reply) => {
      const tenantId = request.tenant!.id;
      const row = await acknowledgeFinding(app.prisma, {
        tenantId,
        key: request.body.key,
        userId: request.user?.id ?? null,
      });
      request.audit({
        action: "assistant.knowledge_finding.acknowledged",
        entityType: "KnowledgeFindingAcknowledgement",
        entityId: row.id,
        after: { code: row.code },
      });
      return reply.status(201).send(await knowledgeHealth(app.prisma, tenantId));
    },
  );

  // phase-12 §3.2 and §8.4: paid, owner-triggered model calls. Both are reads of
  // tenant data as far as the database is concerned, but they spend the AI
  // allowance, so they take the `manage` guard rather than `read`.
  app.post(
    "/knowledge/audit",
    {
      preHandler: manage,
      schema: {
        tags: ["assistant"],
        body: knowledgeAuditRequestSchema,
        response: { 200: knowledgeAuditSchema, ...commonErrorResponses },
      },
    },
    async (request) => {
      const result = await knowledgeAi.audit(request.tenant!.id, request.body.locale);
      if (!result.cached)
        request.audit({
          action: "assistant.knowledge.audited",
          entityType: "Tenant",
          entityId: request.tenant!.id,
          after: { findings: result.findings.length, discarded: result.discarded },
        });
      return result;
    },
  );

  app.post(
    "/knowledge/translation-draft",
    {
      preHandler: manage,
      schema: {
        tags: ["assistant"],
        body: translationDraftRequestSchema,
        response: { 200: translationDraftSchema, ...commonErrorResponses },
      },
    },
    async (request) => {
      const draft = await knowledgeAi.translationDraft(request.tenant!.id, request.body);
      request.audit({
        action: "assistant.knowledge.translation_drafted",
        entityType: "Tenant",
        entityId: request.tenant!.id,
        after: { kind: draft.kind, target: draft.target },
      });
      return draft;
    },
  );

  app.delete(
    "/knowledge/acknowledgements/:id",
    {
      preHandler: manage,
      schema: {
        tags: ["assistant"],
        params: z.object({ id: idSchema }),
        response: { 200: knowledgeHealthSchema, ...commonErrorResponses },
      },
    },
    async (request) => {
      const tenantId = request.tenant!.id;
      await removeAcknowledgement(app.prisma, { tenantId, id: request.params.id });
      request.audit({
        action: "assistant.knowledge_finding.unacknowledged",
        entityType: "KnowledgeFindingAcknowledgement",
        entityId: request.params.id,
      });
      return knowledgeHealth(app.prisma, tenantId);
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
      items: (await service.listConversations(request.tenant!.id, request.query)).map((row) =>
        toConversation(row, row._count.messages),
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
        ...toConversation(
          row,
          row.messages.filter((message) => message.groundingWarnings !== null).length,
        ),
        summary: row.summary,
        messages: row.messages.map((message) => ({
          id: message.id,
          sender: message.sender,
          content: message.content,
          structured: message.structuredContentJson,
          groundingWarnings: groundingWarningsSchema
            .nullable()
            .catch(null)
            .parse(message.groundingWarnings),
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
  businessDescriptionHu: string | null;
  businessDescriptionEn: string | null;
  businessDescriptionDe: string | null;
  businessDescriptionFr: string | null;
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
function toConversation(
  row: {
    id: string;
    locale: string;
    status: string;
    turnCount: number;
    outcomeSuccessful: boolean | null;
    bookingId: string | null;
    customerId: string | null;
    createdAt: Date;
    lastActivityAt: Date;
  },
  flaggedAnswers: number,
) {
  return {
    flaggedAnswers,
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
