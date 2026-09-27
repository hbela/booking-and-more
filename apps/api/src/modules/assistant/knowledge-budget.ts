import {
  KNOWLEDGE_CHARACTER_LIMIT,
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
  return {
    limit: KNOWLEDGE_CHARACTER_LIMIT,
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
        remaining: Math.max(0, KNOWLEDGE_CHARACTER_LIMIT - used),
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
