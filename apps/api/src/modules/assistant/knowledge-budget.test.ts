import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPrismaClient, type PrismaClient } from "@bam/db";
import { knowledgeCharacters } from "@bam/contracts";
import { AssistantService } from "./assistant.service.js";
import { knowledgeUsage } from "./knowledge-budget.js";
import { ServiceCatalogService } from "../services/service.service.js";
import { TenantService } from "../tenants/tenant.service.js";
import { assistantSettingsPatchSchema } from "./assistant.schemas.js";

const databaseUrl = process.env["TEST_DATABASE_URL"];
describe.skipIf(!databaseUrl)("shared knowledge character budget", () => {
  let db: PrismaClient;
  let assistant: AssistantService;
  let catalog: ServiceCatalogService;
  const ids: string[] = [];
  beforeAll(() => {
    db = createPrismaClient({ databaseUrl: databaseUrl! });
    assistant = new AssistantService(db);
    catalog = new ServiceCatalogService(db);
  });
  afterAll(async () => {
    await db.tenant.deleteMany({ where: { id: { in: ids } } });
    await db.$disconnect();
  });
  async function tenant() {
    const row = await db.tenant.create({
      data: {
        name: "Knowledge budget test",
        slug: `knowledge-${crypto.randomUUID()}`,
        defaultLanguage: "en",
      },
    });
    ids.push(row.id);
    return row.id;
  }
  const faq = (locale: "en" | "hu" | "de" | "fr", answer: string) => ({
    locale,
    question: "Q",
    answer,
    active: true,
    sortOrder: 0,
  });

  it("permits all 10,000 Unicode code points in a company profile for each language", async () => {
    const id = await tenant();
    const text = String.fromCodePoint(0x1f600).repeat(10_000);
    expect(knowledgeCharacters(` ${text} `)).toBe(10_000);
    await assistant.saveSettings(
      id,
      assistantSettingsPatchSchema.parse({
        businessDescriptionEn: ` ${text} `,
        businessDescriptionHu: text,
        businessDescriptionDe: text,
        businessDescriptionFr: text,
      }),
      "en",
    );
    expect((await knowledgeUsage(db, id)).locales.map((entry) => entry.used)).toEqual([
      10_000, 10_000, 10_000, 10_000,
    ]);
    await expect(
      assistant.saveSettings(id, { businessDescriptionEn: text + "x" }, "en"),
    ).rejects.toMatchObject({ statusCode: 422 });
    expect((await assistant.getSettings(id))?.businessDescriptionEn).toBe(text);
  });

  it("shares the allowance across profiles, service descriptions and FAQ questions plus answers", async () => {
    const id = await tenant();
    await assistant.saveSettings(id, { businessDescriptionEn: "p".repeat(6000) }, "en");
    await catalog.create({
      tenantId: id,
      input: { name: "Service", durationMinutes: 30, description: "s".repeat(3000) },
    });
    const entry = await assistant.createFaq(id, faq("en", "a".repeat(999)));
    expect((await knowledgeUsage(db, id)).locales.find((row) => row.locale === "en")).toMatchObject(
      { company: 6000, services: 3000, faqs: 1000, used: 10_000 },
    );
    await expect(
      assistant.updateFaq(id, entry.id, faq("en", "a".repeat(1000))),
    ).rejects.toMatchObject({ statusCode: 422 });
    await expect(
      catalog.create({
        tenantId: id,
        input: { name: "Overflow", description: "x", durationMinutes: 30 },
      }),
    ).rejects.toMatchObject({ statusCode: 422 });
    expect(await db.service.count({ where: { tenantId: id } })).toBe(1);
    await assistant.deleteFaq(id, entry.id);
    await assistant.createFaq(id, faq("en", "a".repeat(999)));
  });

  it("rolls back translation replacements and FAQ language changes that overflow another language", async () => {
    const id = await tenant();
    await assistant.saveSettings(id, { businessDescriptionFr: "f".repeat(10_000) }, "en");
    const service = await catalog.create({
      tenantId: id,
      input: {
        name: "Translated",
        durationMinutes: 30,
        translations: [{ locale: "de", name: "Deutsch", description: "original" }],
      },
    });
    await expect(
      catalog.setTranslations({
        tenantId: id,
        serviceId: service.id,
        translations: [{ locale: "fr", name: "French", description: "x" }],
      }),
    ).rejects.toMatchObject({ statusCode: 422 });
    expect(
      (await catalog.repository.findByIdOrThrow({ tenantId: id, serviceId: service.id }))
        .translations[0]?.locale,
    ).toBe("de");
    const entry = await assistant.createFaq(id, faq("en", "answer"));
    await expect(assistant.updateFaq(id, entry.id, faq("fr", "answer"))).rejects.toMatchObject({
      statusCode: 422,
    });
    expect((await assistant.listFaqs(id))[0]?.locale).toBe("en");
  });

  it("serializes competing profile and service saves, allowing only one at the boundary", async () => {
    const id = await tenant();
    await assistant.saveSettings(id, { businessDescriptionEn: "p".repeat(9990) }, "en");
    const results = await Promise.allSettled([
      assistant.saveSettings(id, { businessDescriptionEn: "p".repeat(10_000) }, "en"),
      catalog.create({
        tenantId: id,
        input: { name: "Concurrent", durationMinutes: 30, description: "s".repeat(10) },
      }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect((await knowledgeUsage(db, id)).locales.find((row) => row.locale === "en")?.used).toBe(
      10_000,
    );
  });

  it("allows reductions and unrelated edits to legacy over-limit content but prevents growth", async () => {
    const id = await tenant();
    await db.tenantAssistantSettings.create({
      data: { tenantId: id, businessDescriptionEn: "p".repeat(15_000) },
    });
    await assistant.saveSettings(id, { businessDescriptionEn: "p".repeat(12_000) }, "en");
    await assistant.saveSettings(id, { enabled: true }, "en");
    await expect(
      assistant.saveSettings(id, { businessDescriptionEn: "p".repeat(12_001) }, "en"),
    ).rejects.toMatchObject({ statusCode: 422 });
    await assistant.saveSettings(id, { businessDescriptionEn: "p".repeat(10_000) }, "en");
  });

  it("counts inactive and archived content and prevents moving base descriptions into a full locale", async () => {
    const id = await tenant();
    await assistant.saveSettings(id, { businessDescriptionFr: "f".repeat(10_000) }, "en");
    const service = await catalog.create({
      tenantId: id,
      input: { name: "Archived", description: "abc", durationMinutes: 30 },
    });
    await catalog.archive({ tenantId: id, serviceId: service.id });
    await assistant.createFaq(id, { ...faq("en", "A"), active: false });
    expect((await knowledgeUsage(db, id)).locales.find((row) => row.locale === "en")?.used).toBe(5);
    await expect(new TenantService(db).update(id, { defaultLanguage: "fr" })).rejects.toMatchObject(
      { statusCode: 422 },
    );
  });

  it("isolates tenant budgets and refuses edits to another tenant's service or FAQ", async () => {
    const first = await tenant();
    const second = await tenant();
    await assistant.saveSettings(first, { businessDescriptionEn: "p".repeat(10_000) }, "en");
    const entry = await assistant.createFaq(second, faq("en", "answer"));
    const service = await catalog.create({
      tenantId: second,
      input: { name: "Private", durationMinutes: 30 },
    });
    await expect(assistant.updateFaq(first, entry.id, faq("en", "changed"))).rejects.toMatchObject({
      statusCode: 404,
    });
    await expect(
      catalog.setTranslations({ tenantId: first, serviceId: service.id, translations: [] }),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(
      (await knowledgeUsage(db, second)).locales.find((row) => row.locale === "en")?.used,
    ).toBe(7);
  });
});
