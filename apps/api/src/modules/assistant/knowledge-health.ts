import type { KnowledgeHealth } from "@bam/contracts";
import { languageSchema } from "@bam/contracts";
import type { PrismaClient } from "@bam/db";
import { checkKnowledge, type KnowledgeSnapshot, type KnowledgeText } from "@bam/knowledge-engine";
import { PublicCatalogueService } from "../public/catalogue.service.js";

const PROFILE_FIELDS = {
  hu: "businessDescriptionHu",
  en: "businessDescriptionEn",
  de: "businessDescriptionDe",
  fr: "businessDescriptionFr",
} as const;

/**
 * Where the tenant's prose contradicts its records (phase-12 §3.1, §5.1).
 *
 * Loads exactly what the assistant is given — the bookable catalogue through
 * `PublicCatalogueService`, active FAQs, every profile language — and lets
 * `@bam/knowledge-engine` judge it. Computed on every read, never cached:
 * archiving a provider makes a profile wrong without anybody saving it.
 */
export async function knowledgeHealth(
  prisma: PrismaClient,
  tenantId: string,
): Promise<KnowledgeHealth> {
  const catalogue = new PublicCatalogueService(prisma);
  const [tenant, settings, faqs, facts, locations] = await Promise.all([
    prisma.tenant.findUniqueOrThrow({
      where: { id: tenantId },
      select: { defaultLanguage: true, contactEmail: true, contactPhone: true },
    }),
    prisma.tenantAssistantSettings.findUnique({ where: { tenantId } }),
    prisma.tenantAssistantFaq.findMany({
      where: { tenantId, active: true },
      orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
    }),
    catalogue.bookableFacts(tenantId),
    catalogue.listLocations(tenantId),
  ]);
  const defaultLocale = tenant.defaultLanguage;

  const texts: KnowledgeText[] = [];
  for (const locale of languageSchema.options) {
    const text =
      settings?.[PROFILE_FIELDS[locale]] ||
      (locale === defaultLocale ? settings?.businessDescription : null);
    if (text) texts.push({ kind: "PROFILE", id: null, name: null, locale, text });
  }
  for (const service of facts.services) {
    if (service.description)
      texts.push({
        kind: "SERVICE",
        id: service.id,
        name: service.name,
        locale: defaultLocale,
        text: service.description,
      });
    for (const translation of service.translations) {
      if (translation.description)
        texts.push({
          kind: "SERVICE",
          id: service.id,
          name: translation.name,
          locale: translation.locale,
          text: translation.description,
        });
    }
  }
  for (const faq of faqs) {
    texts.push({
      kind: "FAQ",
      id: faq.id,
      name: faq.question,
      locale: faq.locale,
      text: `${faq.question}\n${faq.answer}`,
    });
  }

  // The hours the assistant states: bookable providers, at active locations.
  const usable = (row: (typeof facts.providers)[number]["workingHours"][number]) =>
    !row.location || (row.location.active && !row.location.archivedAt);

  const snapshot: KnowledgeSnapshot = {
    defaultLocale,
    supportedLocales: settings?.supportedLocales ?? [...languageSchema.options],
    services: facts.services.map((service) => ({
      id: service.id,
      name: service.name,
      names: [service.name, ...service.translations.map((entry) => entry.name)],
      priceMinor: service.priceMinor,
      currency: service.currency,
      translatedLocales: service.translations.map((entry) => entry.locale),
    })),
    providers: facts.providers.map((provider) => ({
      id: provider.id,
      name: provider.displayName,
      hasHours: provider.workingHours.some(usable),
    })),
    locationCities: [
      ...new Set(locations.flatMap((location) => (location.city ? [location.city] : []))),
    ],
    hours: facts.providers.flatMap((provider) =>
      provider.workingHours.filter(usable).map((row) => ({
        weekday: row.weekday,
        startTime: row.startTime,
        endTime: row.endTime,
      })),
    ),
    contactEmail: tenant.contactEmail,
    contactPhone: tenant.contactPhone,
    texts,
  };

  const findings = checkKnowledge(snapshot);
  return {
    errors: findings.filter((entry) => entry.severity === "ERROR").length,
    warnings: findings.filter((entry) => entry.severity === "WARNING").length,
    findings,
  };
}
