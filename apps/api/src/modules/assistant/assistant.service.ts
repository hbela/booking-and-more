import type { PrismaClient, Tenant } from "@bam/db";
import {
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

const PROFILE_FIELDS = {
  hu: "businessDescriptionHu",
  en: "businessDescriptionEn",
  de: "businessDescriptionDe",
  fr: "businessDescriptionFr",
} as const;

export class AssistantService {
  constructor(private readonly prisma: PrismaClient) {}

  async publicConfig(tenant: Tenant) {
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
    const inputLimit = quotaFor(subscription?.plan, "AI_INPUT_TOKENS");
    const outputLimit = quotaFor(subscription?.plan, "AI_OUTPUT_TOKENS");
    const quotaRemaining =
      (inputLimit === null || inputUsed < inputLimit) &&
      (outputLimit === null || outputUsed < outputLimit);
    return {
      available: Boolean(
        settings?.enabled &&
        hasAssistantEntitlement(subscription?.plan, subscription?.status) &&
        quotaRemaining,
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

  async knowledgeContext(tenant: Tenant, locale: string): Promise<string> {
    const [settings, faqs, services, locations] = await Promise.all([
      this.prisma.tenantAssistantSettings.findUnique({ where: { tenantId: tenant.id } }),
      this.prisma.tenantAssistantFaq.findMany({
        where: { tenantId: tenant.id, active: true, locale },
        orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
        take: 50,
      }),
      new PublicCatalogueService(this.prisma).listServices({ tenantId: tenant.id, limit: 50 }),
      this.prisma.location.findMany({
        where: { tenantId: tenant.id, active: true, archivedAt: null },
        select: {
          name: true,
          type: true,
          addressLine1: true,
          addressLine2: true,
          postalCode: true,
          city: true,
          countryCode: true,
        },
        orderBy: { name: "asc" },
        take: 25,
      }),
    ]);
    const description = localizedBusinessDescription(settings, locale, tenant.defaultLanguage);
    return [
      `Business: ${tenant.name}`,
      description ? `Description: ${description}` : "",
      ...locations.map((location) => `Location: ${JSON.stringify(location)}`),
      tenant.contactEmail ? `Email: ${tenant.contactEmail}` : "",
      tenant.contactPhone ? `Phone: ${tenant.contactPhone}` : "",
      tenant.bookingPolicy ? `Booking policy: ${tenant.bookingPolicy}` : "",
      tenant.cancellationPolicy ? `Cancellation policy: ${tenant.cancellationPolicy}` : "",
      ...services.slice(0, 50).map((service) => {
        const localized = localiseService(service, locale);
        // Public, bookable services only. These remain data inside the AI's
        // untrusted business-facts block, never instructions or booking rules.
        return `Service: ${JSON.stringify({
          id: service.id,
          name: localized.name,
          description: localized.description?.slice(0, 2_000) ?? null,
        })}`;
      }),
      ...faqs.map((faq) => `Q: ${faq.question}\nA: ${faq.answer}`),
    ]
      .filter(Boolean)
      .join("\n");
  }

  getSettings(tenantId: string): Promise<AssistantSettingsRow | null> {
    return this.prisma.tenantAssistantSettings.findUnique({ where: { tenantId } });
  }
  saveSettings(
    tenantId: string,
    patch: AssistantSettingsPatch,
    locale = "hu",
  ): Promise<AssistantSettingsRow> {
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
    return this.prisma.tenantAssistantSettings.upsert({
      where: { tenantId },
      create: {
        tenantId,
        enabled: false,
        personaName: locale === "hu" ? "Asszisztens" : "Assistant",
        supportedLocales: [...languageSchema.options],
        ...data,
      },
      update: data,
    });
  }
  listFaqs(tenantId: string): Promise<AssistantFaqRow[]> {
    return this.prisma.tenantAssistantFaq.findMany({
      where: { tenantId },
      orderBy: [{ locale: "asc" }, { sortOrder: "asc" }, { id: "asc" }],
    });
  }
  createFaq(tenantId: string, input: AssistantFaqInput): Promise<AssistantFaqRow> {
    return this.prisma.tenantAssistantFaq.create({ data: { tenantId, ...input } });
  }
  async updateFaq(tenantId: string, id: string, input: AssistantFaqInput) {
    const result = await this.prisma.tenantAssistantFaq.updateMany({
      where: { id, tenantId },
      data: input,
    });
    if (result.count !== 1) throw new NotFoundError("FAQ not found.");
    return this.prisma.tenantAssistantFaq.findFirstOrThrow({ where: { id, tenantId } });
  }
  async deleteFaq(tenantId: string, id: string): Promise<void> {
    const result = await this.prisma.tenantAssistantFaq.deleteMany({ where: { id, tenantId } });
    if (result.count !== 1) throw new NotFoundError("FAQ not found.");
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
  ): Promise<ConversationListRow[]> {
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

export function localizedBusinessDescription(
  settings: Pick<
    AssistantSettingsRow,
    "businessDescription" | (typeof PROFILE_FIELDS)[keyof typeof PROFILE_FIELDS]
  > | null,
  locale: string,
  defaultLanguage: string,
): string | null {
  if (!settings) return null;
  const requestedLocale = languageSchema.safeParse(locale);
  const originalLocale = languageSchema.safeParse(defaultLanguage);
  const requested = requestedLocale.success ? settings[PROFILE_FIELDS[requestedLocale.data]] : null;
  const original = originalLocale.success ? settings[PROFILE_FIELDS[originalLocale.data]] : null;
  return requested || original || settings.businessDescription || null;
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
