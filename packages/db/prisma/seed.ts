/* eslint-disable no-console -- this is a CLI script; console is the output channel */
import { loadEnv } from "@bam/config";
import { createPrismaClient } from "../src/index.js";

/**
 * Development seed.
 *
 * Idempotent — safe to re-run. Refuses to touch a production database: seeds
 * are for local work and CI, and a stray `pnpm db:seed` against production
 * should do nothing rather than something surprising.
 *
 * The pilot tenant is Sunshine Dental (PRD §27).
 */
async function main(): Promise<void> {
  const env = loadEnv();

  if (env.NODE_ENV === "production") {
    console.error("Refusing to seed a production database.");
    process.exit(1);
  }

  const prisma = createPrismaClient({ databaseUrl: env.DATABASE_URL });

  try {
    const tenant = await prisma.tenant.upsert({
      where: { slug: "sunshine-dental" },
      update: {},
      create: {
        slug: "sunshine-dental",
        name: "Sunshine Dental",
        status: "ACTIVE",
        defaultTimezone: "Europe/Budapest",
        defaultLanguage: "hu",
        primaryColor: "#0f766e",
        contactEmail: "hello@sunshine-dental.example",
        contactPhone: "+36 1 234 5678",
        cancellationPolicy: "Az időpont a kezdés előtt legalább 24 órával díjmentesen lemondható.",
        bookingPolicy:
          "This booking service does not provide emergency medical advice. For urgent care, contact the clinic directly.",
      },
    });

    console.log(`Seeded tenant ${tenant.slug} (${tenant.id})`);

    const total = await prisma.tenant.count();
    console.log(`Tenants in database: ${String(total)}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
