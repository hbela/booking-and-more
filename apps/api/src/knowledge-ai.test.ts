import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fakeProviders, FakeKnowledgeAssistant } from "@bam/ai";
import { loadEnv } from "@bam/config";
import { usagePeriodOf } from "@bam/contracts";

import { buildApp, type AppInstance } from "./app.js";

/**
 * phase-12 part 4 through real HTTP: the model-assisted audit (§3.2) and
 * translation drafts (§8.4). The model is scripted, so what is under test is
 * everything around it — metering, the excerpt check, the cache, and that a
 * draft never writes anything.
 */

const databaseUrl = process.env["TEST_DATABASE_URL"];
const RUN = `ka${randomBytes(4).toString("hex")}`;

describe.skipIf(!databaseUrl)("knowledge audit and translation drafts", () => {
  let app: AppInstance;
  let model: FakeKnowledgeAssistant;

  beforeAll(async () => {
    const env = loadEnv({
      source: {
        NODE_ENV: "test",
        LOG_LEVEL: "silent",
        APP_BASE_URL: "http://localhost:3000",
        API_BASE_URL: "http://localhost:3001",
        DATABASE_URL: databaseUrl!,
        CUSTOMER_PII_ENCRYPTION_KEY: "11".repeat(32),
        CUSTOMER_PII_BLIND_INDEX_KEY: "22".repeat(32),
        LAUNCH_ACCESS_MODE: "public",
        BETTER_AUTH_SECRET: "test-secret-that-is-at-least-32-characters-long",
      },
      loadDotenvFile: false,
    });
    model = new FakeKnowledgeAssistant();
    app = await buildApp({
      env,
      logger: false,
      rateLimit: false,
      aiProviders: fakeProviders(),
      knowledgeAssistant: model,
    });
    await app.ready();
  });

  afterAll(async () => {
    const tenants = await app.prisma.tenant.findMany({
      where: { slug: { endsWith: RUN } },
      select: { id: true },
    });
    const where = { tenantId: { in: tenants.map((tenant) => tenant.id) } };
    await app.prisma.usageEvent.deleteMany({ where });
    await app.prisma.usageAggregate.deleteMany({ where });
    await app.prisma.usageReservation.deleteMany({ where });
    await app.prisma.tenant.deleteMany({ where: { id: where.tenantId } });
    await app.prisma.user.deleteMany({ where: { email: { endsWith: `${RUN}@example.test` } } });
    await app.close();
  });

  /** An owner and a Hungarian-default tenant on the uncapped plan, with a profile. */
  async function clinic(label: string) {
    const email = `${label}-${RUN}@example.test`;
    const signUp = await app.inject({
      method: "POST",
      url: "/v1/auth/sign-up/email",
      payload: { email, password: "correct-horse-battery-staple", name: label },
    });
    expect(signUp.statusCode, signUp.body).toBeLessThan(400);
    const setCookie = signUp.headers["set-cookie"];
    const cookie = (Array.isArray(setCookie) ? setCookie : [setCookie ?? ""])
      .map((entry) => entry.split(";")[0])
      .filter(Boolean)
      .join("; ");

    const created = await app.inject({
      method: "POST",
      url: "/v1/tenants",
      headers: { cookie },
      payload: {
        name: label,
        slug: `${label}-${RUN}`,
        defaultTimezone: "Europe/Budapest",
        defaultLanguage: "hu",
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const tenantId = created.json().id as string;
    await app.prisma.subscription.upsert({
      where: { tenantId },
      create: { tenantId, plan: "INTERNAL", status: "NOT_APPLICABLE" },
      update: { plan: "INTERNAL", status: "NOT_APPLICABLE" },
    });
    const headers = { cookie, "x-tenant-id": tenantId };
    const profile = await app.inject({
      method: "PATCH",
      url: "/v1/assistant/settings",
      headers,
      payload: { businessDescriptionHu: "Budapesti rendelő.\nHétfőtől péntekig nyitva." },
    });
    expect(profile.statusCode, profile.body).toBe(200);
    return { tenantId, headers };
  }

  const inputTokens = (tenantId: string) =>
    app.prisma.usageAggregate
      .findUnique({
        where: {
          tenantId_period_category: {
            tenantId,
            period: usagePeriodOf(),
            category: "AI_INPUT_TOKENS",
          },
        },
      })
      .then((row) => row?.quantity ?? 0);

  it("audits once per snapshot, keeps only verbatim excerpts, and meters the call", async () => {
    const site = await clinic("audit");
    model.nextFindings = [
      { ref: "t0", excerpt: "Budapesti  rendelő.", explanation: "Szentendre.", severity: "ERROR" },
      { ref: "t0", excerpt: "Ingyenes parkolás", explanation: "Kitalált.", severity: "WARNING" },
      { ref: "t9", excerpt: "Budapesti", explanation: "Nincs ilyen szöveg.", severity: "ERROR" },
    ];

    const first = await app.inject({
      method: "POST",
      url: "/v1/assistant/knowledge/audit",
      headers: site.headers,
      payload: { locale: "hu" },
    });
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json()).toEqual({
      findings: [
        {
          severity: "ERROR",
          source: { kind: "PROFILE", id: null, name: null, locale: "hu" },
          excerpt: "Budapesti  rendelő.",
          explanation: "Szentendre.",
        },
      ],
      discarded: 2,
      cached: false,
    });
    // The records went in as the truth, the texts as fenced data.
    expect(model.audits.at(-1)!.facts).toContain("Bookable services");
    expect(model.audits.at(-1)!.locale).toBe("hu");
    expect(await inputTokens(site.tenantId)).toBe(200);

    const again = await app.inject({
      method: "POST",
      url: "/v1/assistant/knowledge/audit",
      headers: site.headers,
      payload: { locale: "hu" },
    });
    expect(again.json()).toMatchObject({ cached: true, discarded: 2 });
    expect(model.audits).toHaveLength(1);
    expect(await inputTokens(site.tenantId)).toBe(200);
  });

  it("drafts a translation without saving it, and refuses what cannot be translated", async () => {
    const site = await clinic("draft");
    const draft = await app.inject({
      method: "POST",
      url: "/v1/assistant/knowledge/translation-draft",
      headers: site.headers,
      payload: { target: "en", kind: "PROFILE" },
    });
    expect(draft.statusCode, draft.body).toBe(200);
    expect(draft.json()).toMatchObject({
      source: "hu",
      target: "en",
      profile: "[en] Budapesti rendelő.\nHétfőtől péntekig nyitva.",
      faqs: [],
    });
    const settings = await app.prisma.tenantAssistantSettings.findUnique({
      where: { tenantId: site.tenantId },
    });
    expect(settings?.businessDescriptionEn).toBeNull();

    const sameLanguage = await app.inject({
      method: "POST",
      url: "/v1/assistant/knowledge/translation-draft",
      headers: site.headers,
      payload: { target: "hu", kind: "PROFILE" },
    });
    expect(sameLanguage.statusCode).toBe(422);

    const noFaqs = await app.inject({
      method: "POST",
      url: "/v1/assistant/knowledge/translation-draft",
      headers: site.headers,
      payload: { target: "en", kind: "FAQ" },
    });
    expect(noFaqs.statusCode).toBe(422);

    const faq = await app.inject({
      method: "POST",
      url: "/v1/assistant/faqs",
      headers: site.headers,
      payload: { locale: "hu", question: "Van parkoló?", answer: "Igen, az udvarban." },
    });
    expect(faq.statusCode, faq.body).toBe(201);
    const faqs = await app.inject({
      method: "POST",
      url: "/v1/assistant/knowledge/translation-draft",
      headers: site.headers,
      payload: { target: "de", kind: "FAQ" },
    });
    expect(faqs.json().faqs).toEqual([
      {
        sourceId: faq.json().id,
        question: "[de] Van parkoló?",
        answer: "[de] Igen, az udvarban.",
      },
    ]);
    expect(await app.prisma.tenantAssistantFaq.count({ where: { tenantId: site.tenantId } })).toBe(
      1,
    );

    // A draft missing a piece is refused rather than handed back half done.
    model.translateWith = (input) => input.items.slice(1);
    const partial = await app.inject({
      method: "POST",
      url: "/v1/assistant/knowledge/translation-draft",
      headers: site.headers,
      payload: { target: "en", kind: "FAQ" },
    });
    expect(partial.statusCode).toBe(503);
    model.translateWith = (input) =>
      input.items.map((item) => ({ id: item.id, text: `[${input.to}] ${item.text}` }));
  });

  it("drafts one service's name and description, and only from the caller's own tenant", async () => {
    const site = await clinic("service");
    const service = await app.prisma.service.create({
      data: {
        tenantId: site.tenantId,
        name: "Fogkőeltávolítás",
        slug: `fogko-${RUN}`,
        description: "Ultrahangos tisztítás.",
        durationMinutes: 30,
      },
    });
    const calls = model.translations.length;
    const draft = await app.inject({
      method: "POST",
      url: "/v1/assistant/knowledge/translation-draft",
      headers: site.headers,
      payload: { target: "fr", kind: "SERVICE", serviceId: service.id },
    });
    expect(draft.statusCode, draft.body).toBe(200);
    expect(draft.json()).toMatchObject({
      source: "hu",
      target: "fr",
      kind: "SERVICE",
      profile: null,
      faqs: [],
      service: { name: "[fr] Fogkőeltávolítás", description: "[fr] Ultrahangos tisztítás." },
    });
    // The name travels as its own item, so the prompt translates it rather
    // than keeping it as a name mentioned in prose.
    expect(model.translations[calls]?.items.map((item) => item.id)).toEqual([
      "service:service-name",
      "service:description",
    ]);
    expect(await app.prisma.serviceTranslation.count({ where: { serviceId: service.id } })).toBe(0);

    await app.prisma.service.update({ where: { id: service.id }, data: { description: null } });
    const nameOnly = await app.inject({
      method: "POST",
      url: "/v1/assistant/knowledge/translation-draft",
      headers: site.headers,
      payload: { target: "en", kind: "SERVICE", serviceId: service.id },
    });
    expect(nameOnly.json().service).toEqual({ name: "[en] Fogkőeltávolítás", description: null });

    // Another tenant's service is the same 404 as one that does not exist (rule 5).
    const other = await clinic("service-other");
    const foreign = await app.inject({
      method: "POST",
      url: "/v1/assistant/knowledge/translation-draft",
      headers: other.headers,
      payload: { target: "en", kind: "SERVICE", serviceId: service.id },
    });
    expect(foreign.statusCode).toBe(404);
    expect(foreign.json().error.code).toBe("SERVICE_NOT_FOUND");

    const missingId = await app.inject({
      method: "POST",
      url: "/v1/assistant/knowledge/translation-draft",
      headers: site.headers,
      payload: { target: "en", kind: "SERVICE" },
    });
    expect(missingId.statusCode).toBe(422);
  });

  it("refuses before calling when the month's allowance cannot cover the call", async () => {
    const site = await clinic("quota");
    await app.prisma.subscription.update({
      where: { tenantId: site.tenantId },
      data: { plan: "PROFESSIONAL", status: "ACTIVE" },
    });
    await app.prisma.usageAggregate.create({
      data: {
        tenantId: site.tenantId,
        period: usagePeriodOf(),
        category: "AI_INPUT_TOKENS",
        quantity: 2_000_000_000,
      },
    });
    const calls = model.translations.length;

    const refused = await app.inject({
      method: "POST",
      url: "/v1/assistant/knowledge/translation-draft",
      headers: site.headers,
      payload: { target: "en", kind: "PROFILE" },
    });
    expect(refused.statusCode).toBe(429);
    expect(refused.json().error.code).toBe("USAGE_QUOTA_EXCEEDED");
    expect(model.translations).toHaveLength(calls);
  });

  it("settles the whole reservation when the provider fails", async () => {
    const site = await clinic("failing");
    model.fail = true;
    try {
      const failed = await app.inject({
        method: "POST",
        url: "/v1/assistant/knowledge/translation-draft",
        headers: site.headers,
        payload: { target: "en", kind: "PROFILE" },
      });
      expect(failed.statusCode).toBe(503);
      // 200 counted, reserved with 10% headroom: the provider may have charged.
      expect(await inputTokens(site.tenantId)).toBe(220);
    } finally {
      model.fail = false;
    }
  });

  it("is not available on a plan without the assistant", async () => {
    const site = await clinic("starter");
    await app.prisma.subscription.update({
      where: { tenantId: site.tenantId },
      data: { plan: "STARTER", status: "ACTIVE" },
    });
    const response = await app.inject({
      method: "POST",
      url: "/v1/assistant/knowledge/audit",
      headers: site.headers,
      payload: { locale: "en" },
    });
    expect(response.statusCode).toBe(403);
  });
});
