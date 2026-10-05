import { describe, expect, it, vi } from "vitest";
import { createPrismaClient, type PrismaClient, type Tenant } from "@bam/db";
import { AssistantService, localizedBusinessDescription } from "./assistant.service.js";
import { assistantFaqInputSchema, assistantSettingsPatchSchema } from "./assistant.schemas.js";

function settingsMock(upsert: ReturnType<typeof vi.fn>): PrismaClient {
  const tx = {
    $executeRaw: vi.fn().mockResolvedValue(0),
    tenant: { findUniqueOrThrow: vi.fn().mockResolvedValue({ defaultLanguage: "hu" }) },
    tenantAssistantSettings: { upsert, findUnique: vi.fn().mockResolvedValue(null) },
    service: { findMany: vi.fn().mockResolvedValue([]) },
    tenantAssistantFaq: { findMany: vi.fn().mockResolvedValue([]) },
  };
  return {
    $transaction: (work: (client: typeof tx) => Promise<unknown>) => work(tx),
  } as unknown as PrismaClient;
}

const profile = {
  businessDescription: "Original",
  businessDescriptionHu: "Magyar bemutatkozás",
  businessDescriptionEn: "English company profile",
  businessDescriptionDe: "Deutsches Firmenprofil",
  businessDescriptionFr: "Présentation de l’entreprise",
};

describe("company profile translations", () => {
  it("selects the conversation language independently of the company default", () => {
    expect(localizedBusinessDescription(profile, "hu", "en")).toBe(profile.businessDescriptionHu);
    expect(localizedBusinessDescription(profile, "en", "hu")).toBe(profile.businessDescriptionEn);
    expect(localizedBusinessDescription(profile, "de", "hu")).toBe(profile.businessDescriptionDe);
    expect(localizedBusinessDescription(profile, "fr", "hu")).toBe(profile.businessDescriptionFr);
  });

  it("falls back to the original language for an absent or empty translation", () => {
    expect(
      localizedBusinessDescription({ ...profile, businessDescriptionEn: null }, "en", "hu"),
    ).toBe(profile.businessDescriptionHu);
    expect(
      localizedBusinessDescription({ ...profile, businessDescriptionHu: "" }, "hu", "en"),
    ).toBe(profile.businessDescriptionEn);
  });

  it("preserves legacy profiles and handles missing settings", () => {
    expect(
      localizedBusinessDescription(
        {
          businessDescription: "Legacy profile",
          businessDescriptionHu: null,
          businessDescriptionEn: null,
          businessDescriptionDe: null,
          businessDescriptionFr: null,
        },
        "en",
        "hu",
      ),
    ).toBe("Legacy profile");
    expect(localizedBusinessDescription(null, "hu", "hu")).toBeNull();
  });

  it.each(["de", "fr"] as const)("accepts %s FAQs and all four assistant languages", (locale) => {
    expect(
      assistantFaqInputSchema.parse({ locale, question: "Question", answer: "Answer" }).locale,
    ).toBe(locale);
    expect(
      assistantSettingsPatchSchema.parse({ supportedLocales: ["hu", "en", "de", "fr"] })
        .supportedLocales,
    ).toEqual(["hu", "en", "de", "fr"]);
  });

  it.each([
    ["de", "businessDescriptionDe"],
    ["fr", "businessDescriptionFr"],
  ] as const)(
    "uses %s as the original profile and preserves legacy writes",
    async (locale, field) => {
      expect(
        localizedBusinessDescription({ ...profile, businessDescriptionHu: null }, "hu", locale),
      ).toBe(profile[field]);
      const upsert = vi.fn().mockResolvedValue(profile);
      const prisma = settingsMock(upsert);
      await new AssistantService(prisma).saveSettings(
        "tenant-1",
        { businessDescription: "Updated" },
        locale,
      );
      expect(upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          update: { businessDescription: "Updated", [field]: "Updated" },
        }),
      );
      expect(assistantSettingsPatchSchema.safeParse({ [field]: "x".repeat(10000) }).success).toBe(
        true,
      );
    },
  );

  it("validates and trims each language independently", () => {
    expect(assistantSettingsPatchSchema.parse({ businessDescriptionEn: " English " })).toEqual({
      businessDescriptionEn: "English",
    });
    expect(
      assistantSettingsPatchSchema.safeParse({ businessDescriptionHu: "x".repeat(10000) }).success,
    ).toBe(true);
    expect(assistantSettingsPatchSchema.parse({ businessDescriptionHu: null })).toEqual({
      businessDescriptionHu: null,
    });
  });

  it("includes only the chosen profile in the AI business facts", async () => {
    const prisma = {
      tenantAssistantSettings: { findUnique: vi.fn().mockResolvedValue(profile) },
      tenantAssistantFaq: { findMany: vi.fn().mockResolvedValue([]) },
      service: { findMany: vi.fn().mockResolvedValue([]) },
      provider: { findMany: vi.fn().mockResolvedValue([]) },
      location: { findMany: vi.fn().mockResolvedValue([]) },
      knowledgeFindingAcknowledgement: { findMany: vi.fn().mockResolvedValue([]) },
    } as unknown as PrismaClient;
    const service = new AssistantService(prisma);
    const tenant = { id: "tenant-1", name: "Company", defaultLanguage: "hu" } as Tenant;
    const { businessDescription } = await service.knowledgeContext(tenant, "en");
    expect(businessDescription).toContain(profile.businessDescriptionEn);
    expect(businessDescription).toContain("written in English");
    expect(businessDescription).not.toContain(profile.businessDescriptionHu);
  });

  it("keeps the other language unchanged when saving a translation", async () => {
    const upsert = vi.fn().mockResolvedValue(profile);
    const prisma = settingsMock(upsert);
    await new AssistantService(prisma).saveSettings(
      "tenant-1",
      { businessDescriptionEn: "New English" },
      "hu",
    );
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId: "tenant-1" },
        update: { businessDescriptionEn: "New English" },
      }),
    );
  });

  it("clears the legacy fallback when the original profile is cleared", async () => {
    const upsert = vi.fn().mockResolvedValue(profile);
    const prisma = settingsMock(upsert);
    await new AssistantService(prisma).saveSettings(
      "tenant-1",
      { businessDescriptionHu: null },
      "hu",
    );
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: { businessDescriptionHu: null, businessDescription: null },
      }),
    );
  });
});

const databaseUrl = process.env["TEST_DATABASE_URL"];
describe.skipIf(!databaseUrl)("stored company profile translations", () => {
  it("saves four languages and supplies matching profiles and FAQs to chat", async () => {
    const prisma = createPrismaClient({ databaseUrl: databaseUrl! });
    const tenant = await prisma.tenant.create({
      data: { slug: `profile-${crypto.randomUUID()}`, name: "Profile test", defaultLanguage: "hu" },
    });
    try {
      const service = new AssistantService(prisma);
      await prisma.location.create({
        data: {
          tenantId: tenant.id,
          name: "Main office",
          timezone: "Europe/Budapest",
          addressLine1: "Example street 12",
          city: "Test City",
          postalCode: "1234",
        },
      });
      await service.saveSettings(
        tenant.id,
        { businessDescriptionHu: profile.businessDescriptionHu },
        "hu",
      );
      await service.saveSettings(
        tenant.id,
        { businessDescriptionEn: profile.businessDescriptionEn },
        "hu",
      );
      await service.saveSettings(
        tenant.id,
        {
          businessDescriptionDe: profile.businessDescriptionDe,
          businessDescriptionFr: profile.businessDescriptionFr,
        },
        "hu",
      );
      expect(await service.getSettings(tenant.id)).toMatchObject({
        businessDescriptionHu: profile.businessDescriptionHu,
        businessDescriptionEn: profile.businessDescriptionEn,
        businessDescriptionDe: profile.businessDescriptionDe,
        businessDescriptionFr: profile.businessDescriptionFr,
      });
      const huContext = await service.knowledgeContext(tenant, "hu");
      const enContext = await service.knowledgeContext(tenant, "en");
      expect(enContext.bookableFacts).toContain("Example street 12");
      expect(huContext.bookableFacts).toContain("Example street 12");
      const hu = huContext.businessDescription;
      const en = enContext.businessDescription;
      expect(hu).toContain(profile.businessDescriptionHu);
      expect(hu).not.toContain(profile.businessDescriptionEn);
      expect(en).toContain(profile.businessDescriptionEn);
      expect(en).not.toContain(profile.businessDescriptionHu);
      for (const [locale, field] of [
        ["de", "businessDescriptionDe"],
        ["fr", "businessDescriptionFr"],
      ] as const) {
        await service.createFaq(tenant.id, {
          locale,
          question: `${locale} question`,
          answer: `${locale} approved answer`,
          active: true,
          sortOrder: 0,
        });
        const context = (await service.knowledgeContext(tenant, locale)).businessDescription;
        expect(context).toContain(profile[field]);
        expect(context).not.toContain(profile.businessDescriptionHu);
        expect(context).not.toContain(profile.businessDescriptionEn);
        expect(context).toContain(`${locale} approved answer`);
        expect((await service.knowledgeContext(tenant, "hu")).businessDescription).not.toContain(
          `${locale} approved answer`,
        );
      }
      // phase-12 §4.3: a locale with no FAQs of its own gets the default
      // locale's, labelled — before, an English customer got none at all.
      await service.createFaq(tenant.id, {
        locale: "hu",
        question: "Van parkoló?",
        answer: "hu approved answer",
        active: true,
        sortOrder: 0,
      });
      const enFallback = (await service.knowledgeContext(tenant, "en")).businessDescription;
      expect(enFallback).toContain("FAQ (written in Hungarian)");
      expect(enFallback).toContain("hu approved answer");
      expect((await service.knowledgeContext(tenant, "de")).businessDescription).not.toContain(
        "hu approved answer",
      );
      await service.saveSettings(tenant.id, { businessDescriptionEn: null }, "hu");
      expect((await service.knowledgeContext(tenant, "en")).businessDescription).toContain(
        profile.businessDescriptionHu,
      );
    } finally {
      await prisma.tenant.delete({ where: { id: tenant.id } });
      await prisma.$disconnect();
    }
  });
});
