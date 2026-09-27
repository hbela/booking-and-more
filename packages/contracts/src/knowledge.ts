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
