import type { KnowledgeHealth } from "@bam/contracts";
import { languageSchema, NotFoundError } from "@bam/contracts";
import type { PrismaClient } from "@bam/db";
import {
  checkKnowledge,
  findingKey,
  type GroundingFacts,
  type KnowledgeSnapshot,
  type KnowledgeText,
} from "@bam/knowledge-engine";
import { PublicCatalogueService } from "../public/catalogue.service.js";

const PROFILE_FIELDS = {
  hu: "businessDescriptionHu",
  en: "businessDescriptionEn",
  de: "businessDescriptionDe",
  fr: "businessDescriptionFr",
} as const;

/** What the assistant is given, as plain values — the check's and the audit's input. */
export async function knowledgeSnapshot(
  prisma: PrismaClient,
  tenantId: string,
): Promise<KnowledgeSnapshot> {
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

  return {
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
}

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
  const [snapshot, acknowledgements] = await Promise.all([
    knowledgeSnapshot(prisma, tenantId),
    prisma.knowledgeFindingAcknowledgement.findMany({
      where: { tenantId },
      select: { id: true, findingKey: true },
    }),
  ]);
  const acknowledged = new Map(acknowledgements.map((row) => [row.findingKey, row.id]));
  const findings = checkKnowledge(snapshot).map((finding) => {
    const key = findingKey(finding);
    return { ...finding, key, acknowledgementId: acknowledged.get(key) ?? null };
  });
  const open = findings.filter((entry) => entry.acknowledgementId === null);
  return {
    errors: open.filter((entry) => entry.severity === "ERROR").length,
    warnings: open.filter((entry) => entry.severity === "WARNING").length,
    findings,
  };
}

/**
 * Mark a current finding as intended (phase-12 §3.3). Only a key the check
 * reports *now* is accepted, so the table holds acknowledgements of things the
 * owner was actually shown rather than arbitrary strings.
 */
export async function acknowledgeFinding(
  prisma: PrismaClient,
  args: { tenantId: string; key: string; userId: string | null },
): Promise<{ id: string; code: string }> {
  const health = await knowledgeHealth(prisma, args.tenantId);
  const finding = health.findings.find((entry) => entry.key === args.key);
  if (!finding) throw new NotFoundError("That finding is no longer reported.");
  return prisma.knowledgeFindingAcknowledgement.upsert({
    where: { tenantId_findingKey: { tenantId: args.tenantId, findingKey: args.key } },
    create: {
      tenantId: args.tenantId,
      findingKey: args.key,
      code: finding.code,
      excerpt: finding.excerpt,
      acknowledgedByUserId: args.userId,
    },
    update: {},
    select: { id: true, code: true },
  });
}

export async function removeAcknowledgement(
  prisma: PrismaClient,
  args: { tenantId: string; id: string },
): Promise<void> {
  const result = await prisma.knowledgeFindingAcknowledgement.deleteMany({
    where: { id: args.id, tenantId: args.tenantId },
  });
  if (result.count !== 1) throw new NotFoundError("Acknowledgement not found.");
}

/**
 * What an `ANSWER_FAQ` reply is checked against (phase-12 §4.5): the same
 * records the receptionist was given, plus the people the owner confirmed may
 * be named without being bookable.
 */
export async function groundingFacts(
  prisma: PrismaClient,
  tenantId: string,
): Promise<GroundingFacts> {
  const [snapshot, people] = await Promise.all([
    knowledgeSnapshot(prisma, tenantId),
    prisma.knowledgeFindingAcknowledgement.findMany({
      where: { tenantId, code: "PERSON_NOT_A_PROVIDER" },
      select: { excerpt: true },
    }),
  ]);
  return {
    services: snapshot.services,
    providers: snapshot.providers,
    locationCities: snapshot.locationCities,
    hours: snapshot.hours,
    acknowledgedPeople: people.map((row) => row.excerpt),
  };
}
