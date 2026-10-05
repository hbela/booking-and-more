import { withKnowledgeBudget } from "./knowledge-budget.js";
import type { ChatLimits } from "../public/chat-guards.js";
import { Prisma, type PrismaClient, type Tenant } from "@bam/db";
import {
  ConflictError,
  ErrorCodes,
  ForbiddenError,
  hasAssistantEntitlement,
  languageSchema,
  NotFoundError,
  quotaFor,
  usagePeriodOf,
} from "@bam/contracts";
import type {
  AssistantFaqInput,
  AssistantSettingsInput,
  AssistantSettingsPatch,
} from "./assistant.schemas.js";
import { localiseService, PublicCatalogueService } from "../public/catalogue.service.js";
import { renderBookableFacts, renderBusinessDescription } from "./knowledge-context.js";
import { knowledgeHealth } from "./knowledge-health.js";

const PROFILE_FIELDS = {
  hu: "businessDescriptionHu",
  en: "businessDescriptionEn",
  de: "businessDescriptionDe",
  fr: "businessDescriptionFr",
} as const;

export class AssistantService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly chatLimits?: ChatLimits,
  ) {}

  async publicConfig(tenant: Tenant, ignoreTokenQuota = false) {
    const period = usagePeriodOf();
    const [settings, subscription, aggregates, reserved] = await Promise.all([
      this.prisma.tenantAssistantSettings.findUnique({ where: { tenantId: tenant.id } }),
      this.prisma.subscription.findUnique({ where: { tenantId: tenant.id } }),
      this.prisma.usageAggregate.findMany({
        where: {
          tenantId: tenant.id,
          period,
          category: { in: ["AI_INPUT_TOKENS", "AI_OUTPUT_TOKENS"] },
        },
      }),
      this.prisma.usageReservation.aggregate({
        where: { tenantId: tenant.id, period, status: "RESERVED", expiresAt: { gt: new Date() } },
        _sum: { inputTokens: true, outputTokens: true },
      }),
    ]);
    const personaName = settings?.personaName ?? "Assistant";
    const inputUsed =
      (aggregates.find((row) => row.category === "AI_INPUT_TOKENS")?.quantity ?? 0) +
      (reserved._sum.inputTokens ?? 0);
    const outputUsed =
      (aggregates.find((row) => row.category === "AI_OUTPUT_TOKENS")?.quantity ?? 0) +
      (reserved._sum.outputTokens ?? 0);
    const monthly =
      subscription?.plan === "PROFESSIONAL_PLUS"
        ? this.chatLimits?.plusMonthlyLimit
        : subscription?.plan === "PROFESSIONAL"
          ? this.chatLimits?.professionalMonthlyLimit
          : undefined;
    const inputLimit =
      monthly === undefined
        ? quotaFor(subscription?.plan, "AI_INPUT_TOKENS")
        : monthly * this.chatLimits!.maxInputTokens;
    const outputLimit =
      monthly === undefined
        ? quotaFor(subscription?.plan, "AI_OUTPUT_TOKENS")
        : monthly * this.chatLimits!.maxConversationOutputTokens;
    const quotaRemaining =
      (inputLimit === null || inputUsed < inputLimit) &&
      (outputLimit === null || outputUsed < outputLimit);
    return {
      available: Boolean(
        settings?.enabled &&
        hasAssistantEntitlement(subscription?.plan, subscription?.status) &&
        (ignoreTokenQuota || quotaRemaining),
      ),
      personaName,
      greeting: `${personaName} · ${tenant.name}`,
      supportedLocales: [...languageSchema.options],
      branding: { businessName: tenant.name, logoUrl: tenant.logoUrl },
    };
  }

  /** The authenticated administration boundary for the paid AI feature. */
  async assertEntitled(tenantId: string): Promise<void> {
    const subscription = await this.prisma.subscription.findUnique({
      where: { tenantId },
      select: { plan: true, status: true },
    });

    if (!hasAssistantEntitlement(subscription?.plan, subscription?.status)) {
      throw new ForbiddenError("The AI Receptionist is available on the AI Receptionist plan.");
    }
  }

  /**
   * The assistant's two blocks (phase-12 §4.1): facts rendered from records,
   * which win, and the tenant's prose, which explains. Both are fenced as
   * untrusted data by the prompt.
   */
  async knowledgeContext(
    tenant: Tenant,
    locale: string,
  ): Promise<{ bookableFacts: string; businessDescription: string }> {
    const catalogue = new PublicCatalogueService(this.prisma);
    const [settings, faqs, facts, locations, namedNotBookable] = await Promise.all([
      this.prisma.tenantAssistantSettings.findUnique({ where: { tenantId: tenant.id } }),
      this.faqsFor(tenant, locale),
      catalogue.bookableFacts(tenant.id),
      catalogue.listLocations(tenant.id),
      this.prisma.knowledgeFindingAcknowledgement.findMany({
        where: { tenantId: tenant.id, code: "PERSON_NOT_A_PROVIDER" },
        select: { excerpt: true },
        orderBy: { createdAt: "asc" },
        take: 25,
      }),
    ]);
    const profile = localizedBusinessDescriptionWithLocale(
      settings,
      locale,
      tenant.defaultLanguage,
    );
    return {
      bookableFacts: [
        `Business: ${tenant.name}`,
        renderBookableFacts(
          {
            services: facts.services,
            providers: facts.providers,
            locations: locations.slice(0, 25),
            contactEmail: tenant.contactEmail,
            contactPhone: tenant.contactPhone,
            bookingPolicy: tenant.bookingPolicy,
            cancellationPolicy: tenant.cancellationPolicy,
            namedNotBookable: [...new Set(namedNotBookable.map((row) => row.excerpt))],
          },
          locale,
        ),
      ].join("\n"),
      businessDescription: renderBusinessDescription({
        profile,
        services: facts.services.flatMap((service) => {
          const localized = localiseService(service, locale);
          if (!localized.description) return [];
          const translated = service.translations.some(
            (entry) => entry.locale === locale && entry.description,
          );
          return [
            {
              name: localized.name,
              description: localized.description,
              locale: translated ? locale : tenant.defaultLanguage,
            },
          ];
        }),
        faqs,
      }),
    };
  }

  /**
   * The customer's locale's FAQs, or the default locale's when it has none
   * (phase-12 §4.3) — the same fallback the profile has always had. Before, an
   * English customer got the Hungarian profile and no FAQs at all.
   */
  private async faqsFor(tenant: Tenant, locale: string) {
    const find = (faqLocale: string) =>
      this.prisma.tenantAssistantFaq.findMany({
        where: { tenantId: tenant.id, active: true, locale: faqLocale },
        orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
        take: 50,
        select: { question: true, answer: true, locale: true },
      });
    const own = await find(locale);
    if (own.length > 0 || locale === tenant.defaultLanguage) return own;
    return find(tenant.defaultLanguage);
  }

  getSettings(tenantId: string): Promise<AssistantSettingsRow | null> {
    return this.prisma.tenantAssistantSettings.findUnique({ where: { tenantId } });
  }
  async saveSettings(
    tenantId: string,
    patch: AssistantSettingsPatch,
    locale = "hu",
  ): Promise<AssistantSettingsRow> {
    if (patch.enabled === true) await this.assertMayEnable(tenantId);
    const input = Object.fromEntries(
      Object.entries(patch).filter(([, value]) => value !== undefined),
    ) as Partial<AssistantSettingsInput>;
    const originalField = PROFILE_FIELDS[languageSchema.parse(locale)];
    const originalDescription = input[originalField];
    const data = {
      ...input,
      ...(originalDescription !== undefined ? { businessDescription: originalDescription } : {}),
      ...(input.businessDescription !== undefined && originalDescription === undefined
        ? { [originalField]: input.businessDescription }
        : {}),
    };
    return withKnowledgeBudget(this.prisma, tenantId, (tx) =>
      tx.tenantAssistantSettings.upsert({
        where: { tenantId },
        create: {
          tenantId,
          enabled: false,
          personaName: locale === "hu" ? "Asszisztens" : "Assistant",
          supportedLocales: [...languageSchema.options],
          ...data,
        },
        update: data,
      }),
    );
  }
  /**
   * phase-12 §5.3: switching the assistant on is refused while the knowledge
   * check reports an unacknowledged error. Only the off→on transition — a
   * tenant already live keeps running and may save its other settings, because
   * a provider archived on a Friday must not silently remove the product's
   * main feature.
   */
  private async assertMayEnable(tenantId: string): Promise<void> {
    const current = await this.prisma.tenantAssistantSettings.findUnique({
      where: { tenantId },
      select: { enabled: true },
    });
    if (current?.enabled) return;
    const health = await knowledgeHealth(this.prisma, tenantId);
    if (health.errors === 0) return;
    throw new ConflictError(
      ErrorCodes.KNOWLEDGE_HAS_ERRORS,
      health.errors === 1
        ? "The assistant's knowledge has 1 unresolved error. Fix it or mark it as intended first."
        : `The assistant's knowledge has ${String(health.errors)} unresolved errors. Fix them or mark them as intended first.`,
      { errors: health.errors },
    );
  }

  listFaqs(tenantId: string): Promise<AssistantFaqRow[]> {
    return this.prisma.tenantAssistantFaq.findMany({
      where: { tenantId },
      orderBy: [{ locale: "asc" }, { sortOrder: "asc" }, { id: "asc" }],
    });
  }
  createFaq(tenantId: string, input: AssistantFaqInput): Promise<AssistantFaqRow> {
    return withKnowledgeBudget(this.prisma, tenantId, (tx) =>
      tx.tenantAssistantFaq.create({ data: { tenantId, ...input } }),
    );
  }
  async updateFaq(tenantId: string, id: string, input: AssistantFaqInput) {
    return withKnowledgeBudget(this.prisma, tenantId, async (tx) => {
      const result = await tx.tenantAssistantFaq.updateMany({
        where: { id, tenantId },
        data: input,
      });
      if (result.count !== 1) throw new NotFoundError("FAQ not found.");
      return tx.tenantAssistantFaq.findFirstOrThrow({ where: { id, tenantId } });
    });
  }
  async deleteFaq(tenantId: string, id: string): Promise<void> {
    await withKnowledgeBudget(this.prisma, tenantId, async (tx) => {
      const result = await tx.tenantAssistantFaq.deleteMany({ where: { id, tenantId } });
      if (result.count !== 1) throw new NotFoundError("FAQ not found.");
    });
  }
  listConversations(
    tenantId: string,
    query: {
      limit: number;
      offset: number;
      status?: string | undefined;
      locale?: string | undefined;
      from?: string | undefined;
      to?: string | undefined;
    },
  ): Promise<(ConversationListRow & { _count: { messages: number } })[]> {
    return this.prisma.conversationSession.findMany({
      where: {
        tenantId,
        ...(query.status ? { status: query.status as never } : {}),
        ...(query.locale ? { locale: query.locale } : {}),
        ...(query.from || query.to
          ? {
              lastActivityAt: {
                ...(query.from ? { gte: new Date(query.from) } : {}),
                ...(query.to ? { lt: new Date(query.to) } : {}),
              },
            }
          : {}),
      },
      orderBy: [{ lastActivityAt: "desc" }, { id: "desc" }],
      take: query.limit,
      skip: query.offset,
      include: {
        _count: { select: { messages: { where: { groundingWarnings: { not: Prisma.DbNull } } } } },
      },
    });
  }
  async conversation(tenantId: string, id: string) {
    const row = await this.prisma.conversationSession.findFirst({
      where: { id, tenantId },
      include: { messages: { orderBy: [{ createdAt: "asc" }, { id: "asc" }] } },
    });
    if (!row) throw new NotFoundError("Conversation not found.");
    return row;
  }
  async stats(tenantId: string) {
    const [total, active, completed, successful, usage] = await Promise.all([
      this.prisma.conversationSession.count({ where: { tenantId } }),
      this.prisma.conversationSession.count({ where: { tenantId, status: "ACTIVE" } }),
      this.prisma.conversationSession.count({ where: { tenantId, status: "COMPLETED" } }),
      this.prisma.conversationSession.count({ where: { tenantId, outcomeSuccessful: true } }),
      this.prisma.usageAggregate.findMany({ where: { tenantId } }),
    ]);
    return {
      total,
      active,
      completed,
      successful,
      inputTokens: usage
        .filter((row) => row.category === "AI_INPUT_TOKENS")
        .reduce((sum, row) => sum + row.quantity, 0),
      outputTokens: usage
        .filter((row) => row.category === "AI_OUTPUT_TOKENS")
        .reduce((sum, row) => sum + row.quantity, 0),
    };
  }
}

interface AssistantSettingsRow {
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
  createdAt: Date;
  updatedAt: Date;
}

type ProfileSettings = Pick<
  AssistantSettingsRow,
  "businessDescription" | (typeof PROFILE_FIELDS)[keyof typeof PROFILE_FIELDS]
> | null;

export function localizedBusinessDescription(
  settings: ProfileSettings,
  locale: string,
  defaultLanguage: string,
): string | null {
  return localizedBusinessDescriptionWithLocale(settings, locale, defaultLanguage)?.text ?? null;
}

/** As above, also saying which language the chosen text is written in. */
export function localizedBusinessDescriptionWithLocale(
  settings: ProfileSettings,
  locale: string,
  defaultLanguage: string,
): { text: string; locale: string } | null {
  if (!settings) return null;
  const requestedLocale = languageSchema.safeParse(locale);
  const originalLocale = languageSchema.safeParse(defaultLanguage);
  const requested = requestedLocale.success ? settings[PROFILE_FIELDS[requestedLocale.data]] : null;
  if (requested) return { text: requested, locale };
  const original = originalLocale.success ? settings[PROFILE_FIELDS[originalLocale.data]] : null;
  const fallback = original || settings.businessDescription;
  return fallback ? { text: fallback, locale: defaultLanguage } : null;
}

interface AssistantFaqRow {
  id: string;
  tenantId: string;
  locale: string;
  question: string;
  answer: string;
  active: boolean;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
}

interface ConversationListRow {
  id: string;
  tenantId: string;
  locale: string;
  status: string;
  turnCount: number;
  outcomeSuccessful: boolean | null;
  bookingId: string | null;
  customerId: string | null;
  createdAt: Date;
  lastActivityAt: Date;
}
