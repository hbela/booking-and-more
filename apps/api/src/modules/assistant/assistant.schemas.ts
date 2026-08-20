import { z } from "zod";
import { idSchema, instantSchema, languageSchema } from "@bam/contracts";

export const assistantSettingsInputSchema = z.object({
  enabled: z.boolean(),
  personaName: z.string().trim().min(1).max(80),
  businessDescription: z.string().trim().max(4_000).nullable(),
  supportedLocales: z.array(languageSchema).min(1).max(2),
  escalationMessage: z.string().trim().max(1_000).nullable(),
});
export const assistantSettingsSchema = assistantSettingsInputSchema.extend({
  tenantId: idSchema,
  updatedAt: instantSchema,
});
export const assistantFaqInputSchema = z.object({
  locale: languageSchema,
  question: z.string().trim().min(1).max(500),
  answer: z.string().trim().min(1).max(4_000),
  active: z.boolean().default(true),
  sortOrder: z.number().int().min(0).max(10_000).default(0),
});
export const assistantFaqSchema = assistantFaqInputSchema.extend({
  id: idSchema,
  createdAt: instantSchema,
  updatedAt: instantSchema,
});
export const publicAssistantSchema = z.object({
  available: z.boolean(),
  personaName: z.string(),
  greeting: z.string(),
  supportedLocales: z.array(languageSchema),
  branding: z.object({ businessName: z.string(), logoUrl: z.string().nullable() }),
});
export const conversationListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).default(0),
  status: z.enum(["ACTIVE", "COMPLETED", "CANCELLED", "EXPIRED"]).optional(),
  locale: languageSchema.optional(),
});
export const conversationListItemSchema = z.object({
  id: idSchema,
  locale: z.string(),
  status: z.string(),
  turnCount: z.number().int(),
  outcomeSuccessful: z.boolean().nullable(),
  bookingId: idSchema.nullable(),
  customerId: idSchema.nullable(),
  startedAt: instantSchema,
  lastActivityAt: instantSchema,
});
export const conversationDetailSchema = conversationListItemSchema.extend({
  summary: z.string().nullable(),
  messages: z.array(
    z.object({
      id: idSchema,
      sender: z.string(),
      content: z.string(),
      structured: z.unknown().nullable(),
      createdAt: instantSchema,
    }),
  ),
});
export const conversationStatsSchema = z.object({
  total: z.number().int(),
  active: z.number().int(),
  completed: z.number().int(),
  successful: z.number().int(),
  inputTokens: z.number().int(),
  outputTokens: z.number().int(),
});
export type AssistantSettingsInput = z.infer<typeof assistantSettingsInputSchema>;
export type AssistantFaqInput = z.infer<typeof assistantFaqInputSchema>;
