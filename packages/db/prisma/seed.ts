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

    // --- Availability (Epic 3) ----------------------------------------------
    // Without working hours the catalogue is fully configured and nothing is
    // bookable, which makes a fresh clone look broken. Anna works weekdays with
    // a lunch break — two periods on one day, which is how a break is expressed
    // (tech-impl §10.9). Béla does Tuesday and Thursday afternoons.
    await setWorkingHours(prisma, tenant.id, anna.id, [
      ...[1, 2, 3, 4, 5].flatMap((weekday) => [
        { weekday, startTime: "09:00", endTime: "12:00" },
        { weekday, startTime: "13:00", endTime: "17:00" },
      ]),
    ]);

    await setWorkingHours(prisma, tenant.id, bela.id, [
      { weekday: 2, startTime: "14:00", endTime: "18:00" },
      { weekday: 4, startTime: "14:00", endTime: "18:00" },
    ]);

    // --- A booking (Epic 4) -------------------------------------------------
    // One appointment, so the staff diary is not an empty screen on a fresh
    // clone and the exclusion constraint has something real to refuse against.
    await seedBooking(prisma, {
      tenantId: tenant.id,
      providerId: anna.id,
      serviceId: scaling.id,
      locationId: surgery.id,
      service: scaling,
    });

    console.log(
      `Seeded 2 services, 2 providers, 2 locations, working hours and 1 booking for ${tenant.slug}`,
    );

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

/**
 * Replace a provider's week.
 *
 * Delete-then-insert, matching what the API's PUT does, so re-running the seed
 * converges rather than accumulating duplicate periods.
 */
async function setWorkingHours(
  prisma: PrismaClient,
  tenantId: string,
  providerId: string,
  periods: { weekday: number; startTime: string; endTime: string }[],
) {
  await prisma.workingHours.deleteMany({ where: { tenantId, providerId } });
  await prisma.workingHours.createMany({
    data: periods.map((period) => ({ ...period, tenantId, providerId })),
  });
}

/**
 * One confirmed booking, next Monday at 10:00 local.
 *
 * Idempotent by reference: re-running the seed finds the existing row rather
 * than colliding with the exclusion constraint, which is what a second
 * overlapping reservation would do — correctly, and confusingly for anyone who
 * just wanted to re-seed.
 *
 * The customer here is fictional. Seeds end up in screenshots and demo
 * environments, so nothing in this file should ever be a real person's details.
 */
async function seedBooking(
  prisma: PrismaClient,
  args: {
    tenantId: string;
    providerId: string;
    serviceId: string;
    locationId: string;
    service: {
      name: string;
      durationMinutes: number;
      priceMinor: number | null;
      currency: string | null;
    };
  },
): Promise<void> {
  const reference = "SEED01";

  const existing = await prisma.booking.findFirst({
    where: { tenantId: args.tenantId, reference },
    select: { id: true },
  });
  if (existing) return;

  // Next Monday, 08:00 UTC.
  //
  // The hour is chosen so the booking sits inside a period the availability
  // engine would actually offer, in both halves of the year: Anna works
  // 09:00-12:00 and 13:00-17:00 local, and 08:00 UTC is 10:00 in Budapest
  // summer time and 09:00 in winter. 10:00 UTC — the obvious first guess —
  // is 12:00 local in summer, which is the middle of her lunch break, and a
  // demo booking sitting in a gap nobody can book is a confusing thing to
  // hand somebody on their first run.
  const startAt = new Date();
  startAt.setUTCDate(startAt.getUTCDate() + ((8 - startAt.getUTCDay()) % 7 || 7));
  startAt.setUTCHours(8, 0, 0, 0);
  const endAt = new Date(startAt.getTime() + args.service.durationMinutes * 60_000);

  await prisma.$transaction(async (tx) => {
    const customer = await tx.customer.create({
      data: {
        tenantId: args.tenantId,
        fullName: "Példa Piroska",
        email: "piroska@example.test",
        normalizedEmail: "piroska@example.test",
        preferredLanguage: "hu",
      },
    });

    const booking = await tx.booking.create({
      data: {
        tenantId: args.tenantId,
        reference,
        customerId: customer.id,
        providerId: args.providerId,
        serviceId: args.serviceId,
        locationId: args.locationId,
        startAt,
        endAt,
        status: "CONFIRMED",
        source: "STAFF",
        customerNameSnapshot: customer.fullName,
        customerEmailSnapshot: customer.email,
        serviceNameSnapshot: args.service.name,
        priceMinorSnapshot: args.service.priceMinor,
        currencySnapshot: args.service.currency,
      },
    });

    // The reservation carries the occupied span. This service has no buffers,
    // so it matches the appointment; with buffers it would be wider.
    await tx.capacityReservation.create({
      data: {
        tenantId: args.tenantId,
        providerId: args.providerId,
        bookingId: booking.id,
        startAt,
        endAt,
      },
    });
  });
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
