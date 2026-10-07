import {
  knowledgeCharacters,
  languageSchema,
  ValidationError,
  type KnowledgeUsage,
} from "@bam/contracts";
import type { Prisma, PrismaClient } from "@bam/db";

const fields = {
  hu: "businessDescriptionHu",
  en: "businessDescriptionEn",
  de: "businessDescriptionDe",
  fr: "businessDescriptionFr",
} as const;

/**
 * `KNOWLEDGE_CHARACTER_LIMIT`, set once by `buildApp` from `@bam/config`.
 *
 * Module state rather than a constructor argument because a dozen call sites
 * across three services reach the budget, and a forgotten argument would fall
 * back to a default silently. Unset, every read throws instead: a path that
 * reaches the budget without the composition root is a bug to find, not a
 * number to guess (docs/phase-12-knowledge-allowance-and-prompt-caching.md §6).
 */
let configuredLimit: number | undefined;

export function configureKnowledgeBudget(options: { limit: number }): void {
  if (!Number.isSafeInteger(options.limit) || options.limit <= 0)
    throw new Error("The knowledge character limit must be a positive integer.");
  configuredLimit = options.limit;
}

function knowledgeLimit(): number {
  if (configuredLimit === undefined)
    throw new Error("The knowledge budget was used before configureKnowledgeBudget().");
  return configuredLimit;
}

/** Count stored text, including inactive FAQs and archived services. Legacy profile is an alias. */
export async function knowledgeUsage(
  db: Prisma.TransactionClient,
  tenantId: string,
): Promise<KnowledgeUsage> {
  // A transaction owns one connection: issue these reads sequentially.
  const tenant = await db.tenant.findUniqueOrThrow({
    where: { id: tenantId },
    select: { defaultLanguage: true },
  });
  const settings = await db.tenantAssistantSettings.findUnique({ where: { tenantId } });
  const services = await db.service.findMany({
    where: { tenantId },
    select: { description: true, translations: { select: { locale: true, description: true } } },
  });
  const faqs = await db.tenantAssistantFaq.findMany({
    where: { tenantId },
    select: { locale: true, question: true, answer: true },
  });
  const defaultLocale = languageSchema.parse(tenant.defaultLanguage);
  const limit = knowledgeLimit();
  return {
    limit,
    defaultLocale,
    locales: languageSchema.options.map((locale) => {
      const company = knowledgeCharacters(
        settings?.[fields[locale]] ||
          (locale === defaultLocale ? settings?.businessDescription : null),
      );
      const serviceCount = services.reduce(
        (sum, service) =>
          sum +
          (locale === defaultLocale ? knowledgeCharacters(service.description) : 0) +
          service.translations
            .filter((entry) => entry.locale === locale)
            .reduce((total, entry) => total + knowledgeCharacters(entry.description), 0),
        0,
      );
      const faqCount = faqs
        .filter((faq) => faq.locale === locale)
        .reduce(
          (sum, faq) => sum + knowledgeCharacters(faq.question) + knowledgeCharacters(faq.answer),
          0,
        );
      const used = company + serviceCount + faqCount;
      return {
        locale,
        company,
        services: serviceCount,
        faqs: faqCount,
        used,
        remaining: Math.max(0, limit - used),
      };
    }),
  };
}

/** All knowledge writers take the same tenant lock. Rejecting rolls back the entire edit. */
export async function withKnowledgeBudget<T>(
  db: PrismaClient,
  tenantId: string,
  write: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return db.$transaction(async (tx) => {
    const lock = "knowledge-budget:" + tenantId;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lock}, 0))`;
    const before = await knowledgeUsage(tx, tenantId);
    const result = await write(tx);
    const after = await knowledgeUsage(tx, tenantId);
    for (const usage of after.locales) {
      const previous = before.locales.find((entry) => entry.locale === usage.locale)!.used;
      if (usage.used > after.limit && usage.used > previous) {
        throw new ValidationError(
          `The ${usage.locale.toUpperCase()} content exceeds the shared ${after.limit.toLocaleString("en-US")}-character allowance. Shorten the company description, service descriptions or FAQs.`,
          {
            field: "knowledge",
            locale: usage.locale,
            limit: after.limit,
            used: usage.used,
          },
        );
      }
    }
    return result;
  });
}
