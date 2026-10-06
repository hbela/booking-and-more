import { z } from "zod";
import { idSchema, languageSchema } from "./common.js";

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
  /** `@bam/knowledge-engine`'s `findingKey` — what an acknowledgement names. */
  key: z.string(),
  /** Set when the owner marked this finding as intended (phase-12 §3.3). */
  acknowledgementId: z.string().nullable(),
});
export const knowledgeHealthSchema = z.object({
  /** Unacknowledged only: these are what the enable gate counts (phase-12 §5.3). */
  errors: z.number().int(),
  warnings: z.number().int(),
  findings: z.array(knowledgeFindingSchema),
});
export type KnowledgeFindingView = z.infer<typeof knowledgeFindingSchema>;
export type KnowledgeHealth = z.infer<typeof knowledgeHealthSchema>;

export const acknowledgeKnowledgeFindingSchema = z.object({
  key: z.string().min(1).max(2_000),
});

/**
 * phase-12 §3.2: the model-assisted audit. Advisory — never counted by the
 * enable gate, never acknowledged. Each excerpt has been verified to occur in
 * the text it names; `discarded` says how many the model invented.
 */
export const knowledgeAuditRequestSchema = z.object({
  /** The language the owner reads; explanations come back in it. */
  locale: languageSchema,
});
export const knowledgeAuditSchema = z.object({
  findings: z.array(
    z.object({
      severity: z.enum(["ERROR", "WARNING"]),
      source: knowledgeFindingSchema.shape.source,
      excerpt: z.string(),
      explanation: z.string(),
    }),
  ),
  discarded: z.number().int(),
  /** True when an identical snapshot was audited before and nothing was spent. */
  cached: z.boolean(),
});
export type KnowledgeAudit = z.infer<typeof knowledgeAuditSchema>;

/**
 * phase-12 §8.4: a machine translation of the default-language profile, FAQs,
 * or one service's name and description (docs/phase-12-service-translation-drafts.md).
 * A draft — nothing is saved; the owner reviews and saves it like any edit.
 */
export const translationDraftKindSchema = z.enum(["PROFILE", "FAQ", "SERVICE"]);
export const translationDraftRequestSchema = z.discriminatedUnion("kind", [
  z.object({ target: languageSchema, kind: z.literal("PROFILE") }),
  z.object({ target: languageSchema, kind: z.literal("FAQ") }),
  z.object({ target: languageSchema, kind: z.literal("SERVICE"), serviceId: idSchema }),
]);
export type TranslationDraftRequest = z.infer<typeof translationDraftRequestSchema>;
export const translationDraftSchema = z.object({
  source: languageSchema,
  target: languageSchema,
  kind: translationDraftKindSchema,
  profile: z.string().nullable(),
  faqs: z.array(z.object({ sourceId: z.string(), question: z.string(), answer: z.string() })),
  service: z.object({ name: z.string(), description: z.string().nullable() }).nullable(),
});
export type TranslationDraft = z.infer<typeof translationDraftSchema>;

/**
 * docs/phase-12-site-import.md: drafts of the default-language profile, service
 * proposals and FAQs, read from the organization's own website. Nothing is
 * saved; each piece goes through its ordinary editor.
 */
export const siteImportDraftSchema = z.object({
  domain: z.string(),
  language: languageSchema,
  pages: z.array(z.object({ url: z.string(), title: z.string().nullable() })),
  profile: z.string().nullable(),
  services: z.array(
    z.object({
      name: z.string(),
      description: z.string().nullable(),
      /** Major units, as the create form takes it. */
      price: z.number().nullable(),
      currency: z.string().nullable(),
      durationMinutes: z.number().int().nullable(),
      sourceUrl: z.string(),
      /** A service of the same name is already in the catalogue. */
      existingServiceId: z.string().nullable(),
    }),
  ),
  faqs: z.array(z.object({ question: z.string(), answer: z.string(), sourceUrl: z.string() })),
  /** Proposals dropped because they named something the site does not. */
  discarded: z.number().int(),
  cached: z.boolean(),
});
export type SiteImportDraft = z.infer<typeof siteImportDraftSchema>;
