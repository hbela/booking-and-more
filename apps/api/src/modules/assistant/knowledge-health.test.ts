import { createPrismaClient } from "@bam/db";
import { describe, expect, it } from "vitest";
import { AssistantService } from "./assistant.service.js";
import { knowledgeHealth } from "./knowledge-health.js";

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
});
