import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkDatabaseConnection, createPrismaClient, hasExtension } from "./index.js";
import type { PrismaClient } from "./index.js";

/**
 * Integration tests against a real PostgreSQL instance.
 *
 * tech-impl §39.3 specifies Testcontainers. Docker is not installed on the
 * development machine, so these run against TEST_DATABASE_URL instead — the
 * native Postgres locally, a `postgres:18` service container in CI. Same SQL,
 * same extensions. Swapping to Testcontainers later is a change confined to
 * this file's setup.
 */

const databaseUrl = process.env["TEST_DATABASE_URL"];

describe.skipIf(!databaseUrl)("database", () => {
  let prisma: PrismaClient;

  beforeAll(() => {
    prisma = createPrismaClient({ databaseUrl: databaseUrl! });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("connects and reports latency", async () => {
    const result = await checkDatabaseConnection(prisma);

    expect(result.ok).toBe(true);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.error).toBeUndefined();
  });

  it("has btree_gist installed — Epic 4's exclusion constraint depends on it", async () => {
    expect(await hasExtension(prisma, "btree_gist")).toBe(true);
  });

  it("has citext installed", async () => {
    expect(await hasExtension(prisma, "citext")).toBe(true);
  });

  it("proves btree_gist can build the constraint the booking engine will need", async () => {
    // Rehearses the real thing (tech-impl §11.3) so that a database provisioned
    // without btree_gist fails here rather than in Epic 4.
    //
    // A real (not TEMPORARY) table: the driver adapter pools connections, and a
    // temp table would only exist on whichever connection created it.
    const table = `capacity_probe_${Date.now().toString(36)}`;
    const insert = (provider: string, from: string, to: string) =>
      prisma.$executeRawUnsafe(
        `INSERT INTO "${table}" VALUES ('${provider}', '${from}', '${to}', 'ACTIVE')`,
      );

    await prisma.$executeRawUnsafe(`
      CREATE TABLE "${table}" (
        provider_id text NOT NULL,
        start_at timestamptz NOT NULL,
        end_at timestamptz NOT NULL,
        status text NOT NULL,
        EXCLUDE USING gist (
          provider_id WITH =,
          tstzrange(start_at, end_at, '[)') WITH &&
        ) WHERE (status = 'ACTIVE')
      )
    `);

    try {
      await insert("provider_1", "2026-08-05T14:00:00Z", "2026-08-05T14:30:00Z");

      // An overlapping reservation for the same provider must be rejected by
      // the database, not by application code.
      await expect(
        insert("provider_1", "2026-08-05T14:15:00Z", "2026-08-05T14:45:00Z"),
      ).rejects.toThrow();

      // Back-to-back is fine: the range is half-open, so 14:30 does not overlap.
      await expect(
        insert("provider_1", "2026-08-05T14:30:00Z", "2026-08-05T15:00:00Z"),
      ).resolves.toBeDefined();

      // A different provider at the same time is fine.
      await expect(
        insert("provider_2", "2026-08-05T14:15:00Z", "2026-08-05T14:45:00Z"),
      ).resolves.toBeDefined();
    } finally {
      await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "${table}"`);
    }
  });

  it("applies the tenants migration with a case-insensitive slug", async () => {
    const slug = `test-tenant-${Date.now().toString(36)}`;

    const created = await prisma.tenant.create({
      data: { slug, name: "Test Tenant" },
    });

    try {
      expect(created.status).toBe("TRIAL");
      expect(created.defaultTimezone).toBe("Europe/Budapest");
      expect(created.defaultLanguage).toBe("hu");

      // citext: the same slug in different case must be the same tenant.
      const found = await prisma.tenant.findUnique({ where: { slug: slug.toUpperCase() } });
      expect(found?.id).toBe(created.id);

      // ...and must not be registrable twice.
      await expect(
        prisma.tenant.create({ data: { slug: slug.toUpperCase(), name: "Impostor" } }),
      ).rejects.toThrow();
    } finally {
      await prisma.tenant.delete({ where: { id: created.id } });
    }
  });
});
