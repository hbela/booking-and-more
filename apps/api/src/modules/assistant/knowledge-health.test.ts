import { createPrismaClient } from "@bam/db";
import { describe, expect, it } from "vitest";
import { AssistantService } from "./assistant.service.js";
import { acknowledgeFinding, knowledgeHealth, removeAcknowledgement } from "./knowledge-health.js";

const databaseUrl = process.env["TEST_DATABASE_URL"];

describe.skipIf(!databaseUrl)("knowledgeHealth", () => {
  it("judges the tenant's own prose against its own records, and nobody else's", async () => {
    const prisma = createPrismaClient({ databaseUrl: databaseUrl! });
    const [tenant, other] = await Promise.all(
      ["health", "health-other"].map((prefix) =>
        prisma.tenant.create({
          data: { slug: `${prefix}-${crypto.randomUUID()}`, name: prefix, defaultLanguage: "hu" },
        }),
      ),
    );
    try {
      const assistant = new AssistantService(prisma);
      await prisma.location.create({
        data: {
          tenantId: tenant!.id,
          name: "Central",
          timezone: "Europe/Budapest",
          city: "Szentendre",
        },
      });
      await assistant.saveSettings(
        tenant!.id,
        { businessDescriptionHu: "Budapesti rendelő. Dr. Nincs Senki vezetésével." },
        "hu",
      );
      // Another tenant's contradiction must not appear in this tenant's list.
      await assistant.saveSettings(
        other!.id,
        { businessDescriptionHu: "Debreceni rendelő." },
        "hu",
      );

      const health = await knowledgeHealth(prisma, tenant!.id);

      expect(health.findings.map((entry) => entry.code)).toEqual(
        expect.arrayContaining(["CITY_MISMATCH", "PERSON_NOT_A_PROVIDER", "CONTACT_MISSING"]),
      );
      expect(health.findings.find((entry) => entry.code === "CITY_MISMATCH")).toMatchObject({
        suggestion: "Budapest",
        expected: ["Szentendre"],
      });
      expect(JSON.stringify(health)).not.toContain("Debrecen");
      expect(health.errors).toBe(
        health.findings.filter((entry) => entry.severity === "ERROR").length,
      );
    } finally {
      await prisma.tenant.deleteMany({ where: { id: { in: [tenant!.id, other!.id] } } });
      await prisma.$disconnect();
    }
  });

  it("refuses enabling over an error until it is acknowledged, and never disables (§3.3, §5.3)", async () => {
    const prisma = createPrismaClient({ databaseUrl: databaseUrl! });
    const tenant = await prisma.tenant.create({
      data: {
        slug: `gate-${crypto.randomUUID()}`,
        name: "Gate",
        defaultLanguage: "hu",
        contactEmail: "info@example.test",
      },
    });
    try {
      const assistant = new AssistantService(prisma);
      await assistant.saveSettings(
        tenant.id,
        { businessDescriptionHu: "Dr. Kocsis Zoltán vezeti a rendelőt." },
        "hu",
      );

      const before = await knowledgeHealth(prisma, tenant.id);
      expect(before.errors).toBe(1);
      const person = before.findings.find((entry) => entry.code === "PERSON_NOT_A_PROVIDER")!;

      await expect(
        assistant.saveSettings(tenant.id, { enabled: true }, "hu"),
      ).rejects.toMatchObject({
        code: "KNOWLEDGE_HAS_ERRORS",
        statusCode: 409,
        details: { errors: 1 },
      });
      expect((await assistant.getSettings(tenant.id))?.enabled).toBe(false);

      // A key the check does not report now is refused, so the table only holds
      // what the owner was actually shown.
      await expect(
        acknowledgeFinding(prisma, { tenantId: tenant.id, key: "made-up", userId: null }),
      ).rejects.toMatchObject({ statusCode: 404 });

      const acknowledgement = await acknowledgeFinding(prisma, {
        tenantId: tenant.id,
        key: person.key,
        userId: null,
      });
      const after = await knowledgeHealth(prisma, tenant.id);
      expect(after.errors).toBe(0);
      expect(after.findings.find((entry) => entry.key === person.key)?.acknowledgementId).toBe(
        acknowledgement.id,
      );

      // The acknowledged name reaches the assistant as "named, not bookable".
      expect((await assistant.knowledgeContext(tenant, "hu")).bookableFacts).toMatch(
        /cannot be booked \(confirmed by the business[^]*- Kocsis Zoltán/u,
      );

      await assistant.saveSettings(tenant.id, { enabled: true }, "hu");
      expect((await assistant.getSettings(tenant.id))?.enabled).toBe(true);

      // A new error does not switch a live assistant off, nor block its other settings.
      await removeAcknowledgement(prisma, { tenantId: tenant.id, id: acknowledgement.id });
      expect((await knowledgeHealth(prisma, tenant.id)).errors).toBe(1);
      await assistant.saveSettings(tenant.id, { enabled: true, personaName: "Recepció" }, "hu");
      expect(await assistant.getSettings(tenant.id)).toMatchObject({
        enabled: true,
        personaName: "Recepció",
      });

      // Rewording the sentence is a new finding, not the acknowledged one.
      await acknowledgeFinding(prisma, { tenantId: tenant.id, key: person.key, userId: null });
      await assistant.saveSettings(
        tenant.id,
        { businessDescriptionHu: "Dr. Kocsis Péter vezeti a rendelőt." },
        "hu",
      );
      expect((await knowledgeHealth(prisma, tenant.id)).errors).toBe(1);

      await expect(
        removeAcknowledgement(prisma, { tenantId: tenant.id, id: "missing" }),
      ).rejects.toMatchObject({ statusCode: 404 });
    } finally {
      await prisma.tenant.delete({ where: { id: tenant.id } });
      await prisma.$disconnect();
    }
  });
});
