/* eslint-disable no-console -- this is a CLI script; console is the output channel */
import { loadEnv } from "@bam/config";
import { createPrismaClient, type PrismaClient } from "../src/index.js";

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

    // --- Catalogue (Epic 2) -------------------------------------------------
    // Enough of a clinic that the public booking page has something to show,
    // and that Epic 3 has real schedules to compute availability against.
    //
    // Upserted on a natural key rather than an id, so a second run updates
    // rather than duplicating. Providers and locations have no unique business
    // key in the schema — a clinic may genuinely have two rooms called
    // "Surgery" — so those are matched on (tenant, name) by hand.

    const surgery = await upsertLocation(prisma, tenant.id, {
      name: "Fő rendelő",
      type: "PHYSICAL",
      addressLine1: "Váci út 1.",
      city: "Budapest",
      postalCode: "1132",
      countryCode: "HU",
      timezone: tenant.defaultTimezone,
    });

    const video = await upsertLocation(prisma, tenant.id, {
      name: "Online konzultáció",
      type: "ONLINE",
      timezone: tenant.defaultTimezone,
    });

    const [scaling, consultation] = await Promise.all([
      prisma.service.upsert({
        where: { tenantId_slug: { tenantId: tenant.id, slug: "fogkoeltavolitas" } },
        update: {},
        create: {
          tenantId: tenant.id,
          slug: "fogkoeltavolitas",
          name: "Fogkőeltávolítás",
          description: "Ultrahangos fogkőeltávolítás és polírozás.",
          durationMinutes: 45,
          bufferAfterMinutes: 10,
          priceMinor: 1_500_000,
          currency: "HUF",
          translations: {
            create: [
              {
                locale: "en",
                name: "Scale and polish",
                description: "Ultrasonic scaling followed by a polish.",
              },
            ],
          },
        },
      }),
      prisma.service.upsert({
        where: { tenantId_slug: { tenantId: tenant.id, slug: "konzultacio" } },
        update: {},
        create: {
          tenantId: tenant.id,
          slug: "konzultacio",
          name: "Konzultáció",
          durationMinutes: 20,
          // No price: "egyedi ajánlat" is a real answer, and different from free.
          translations: { create: [{ locale: "en", name: "Consultation" }] },
        },
      }),
    ]);

    const anna = await upsertProvider(prisma, tenant.id, {
      displayName: "Dr. Kovács Anna",
      description: "Konzerváló fogászat és parodontológia.",
      timezone: tenant.defaultTimezone,
      languages: ["hu", "en"],
    });

    const bela = await upsertProvider(prisma, tenant.id, {
      displayName: "Dr. Nagy Béla",
      timezone: tenant.defaultTimezone,
      languages: ["hu"],
    });

    // Anna does everything, in person and online. Béla consults only, in person.
    await assign(prisma, tenant.id, anna.id, {
      serviceIds: [scaling.id, consultation.id],
      locationIds: [surgery.id, video.id],
    });

    await assign(prisma, tenant.id, bela.id, {
      serviceIds: [consultation.id],
      locationIds: [surgery.id],
    });

    console.log(`Seeded 2 services, 2 providers and 2 locations for ${tenant.slug}`);

    const total = await prisma.tenant.count();
    console.log(`Tenants in database: ${String(total)}`);
  } finally {
    await prisma.$disconnect();
  }
}

/**
 * Upsert on (tenant, name).
 *
 * Providers and locations have no unique business key — a clinic may really
 * have two rooms called "Surgery" — so the schema does not constrain it and the
 * seed cannot use `upsert`. Idempotence here is a property of the seed, not of
 * the data model.
 */
async function upsertProvider(
  prisma: PrismaClient,
  tenantId: string,
  data: { displayName: string; description?: string; timezone: string; languages: string[] },
) {
  const existing = await prisma.provider.findFirst({
    where: { tenantId, displayName: data.displayName },
  });

  if (existing) return existing;
  return prisma.provider.create({ data: { ...data, tenantId } });
}

async function upsertLocation(
  prisma: PrismaClient,
  tenantId: string,
  data: {
    name: string;
    type: "PHYSICAL" | "ONLINE" | "HOME_VISIT" | "TELEPHONE";
    timezone: string;
    addressLine1?: string;
    city?: string;
    postalCode?: string;
    countryCode?: string;
  },
) {
  const existing = await prisma.location.findFirst({ where: { tenantId, name: data.name } });

  if (existing) return existing;
  return prisma.location.create({ data: { ...data, tenantId } });
}

/** Assign services and locations to a provider, idempotently. */
async function assign(
  prisma: PrismaClient,
  tenantId: string,
  providerId: string,
  links: { serviceIds: string[]; locationIds: string[] },
) {
  for (const serviceId of links.serviceIds) {
    await prisma.providerService.upsert({
      where: { providerId_serviceId: { providerId, serviceId } },
      update: {},
      create: { tenantId, providerId, serviceId },
    });
  }

  for (const locationId of links.locationIds) {
    await prisma.providerLocation.upsert({
      where: { providerId_locationId: { providerId, locationId } },
      update: {},
      create: { tenantId, providerId, locationId },
    });
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
