import { z } from "zod";
import { languageSchema } from "./common.js";

export const KNOWLEDGE_CHARACTER_LIMIT = 10_000;
export function knowledgeCharacters(text: string | null | undefined): number {
  return Array.from(text?.trim() ?? "").length;
}
export const knowledgeUsageSchema = z.object({
  limit: z.number().int(),
  defaultLocale: languageSchema,
  locales: z.array(
    z.object({
      locale: languageSchema,
      company: z.number().int(),
      services: z.number().int(),
      faqs: z.number().int(),
      used: z.number().int(),
      remaining: z.number().int(),
    }),
  ),
});
export type KnowledgeUsage = z.infer<typeof knowledgeUsageSchema>;

/**
 * `GET /v1/assistant/knowledge/health` (phase-12 §3, §5.1). The shape is
 * `@bam/knowledge-engine`'s `KnowledgeFinding`; it is declared here as well
 * because the engine has no runtime dependencies and the web reads this one.
 */
export const knowledgeFindingCodeSchema = z.enum([
  "UNBOOKABLE_SERVICE_MENTIONED",
  "PERSON_NOT_A_PROVIDER",
  "CITY_MISMATCH",
  "HOURS_MISMATCH",
  "HOURS_STATED",
  "PRICE_NOT_RECORDED",
  "DUPLICATED_FACT",
  "LOCALE_MISSING",
  "PERSONAL_DATA",
  "CONTACT_MISSING",
  "PROVIDER_WITHOUT_HOURS",
]);
export const knowledgeFindingSchema = z.object({
  code: knowledgeFindingCodeSchema,
  severity: z.enum(["ERROR", "WARNING"]),
  rule: z.enum(["K1", "K2", "K3", "K4", "K5", "K6", "K7", "K8"]).nullable(),
  source: z.object({
    kind: z.enum(["PROFILE", "SERVICE", "FAQ", "RECORDS"]),
    id: z.string().nullable(),
    name: z.string().nullable(),
    locale: z.string().nullable(),
  }),
  excerpt: z.string(),
  expected: z.array(z.string()),
  suggestion: z.string().nullable(),
});
export const knowledgeHealthSchema = z.object({
  errors: z.number().int(),
  warnings: z.number().int(),
  findings: z.array(knowledgeFindingSchema),
});
export type KnowledgeFindingView = z.infer<typeof knowledgeFindingSchema>;
export type KnowledgeHealth = z.infer<typeof knowledgeHealthSchema>;
