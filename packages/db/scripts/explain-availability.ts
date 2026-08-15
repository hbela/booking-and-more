/* eslint-disable no-console -- CLI script; console is the output channel */
import { generateSlots, weekdayOf, type TimePeriod } from "@bam/availability-engine";
import { loadEnv } from "@bam/config";
import { createPrismaClient } from "../src/index.js";

/**
 * Why the booking page is offering no times.
 *
 *   pnpm db:explain-availability <tenant-slug> [YYYY-MM-DD] [--service <slug>] [--provider <name>]
 *
 * An empty slot list is the honest answer to a real search that matched nobody
 * (`AvailabilityService.searchSlots`), and it is indistinguishable from a
 * misconfiguration — which is the whole problem. A provider with hours in the
 * dashboard and nothing on the booking page can be any of eight things, and the
 * screen that would tell you which is exactly the screen rule 7 forbids.
 *
 * So this is a script, like `db:discard-organization` and for the same reason.
 * It walks the same gates `searchSlots` walks, in the same order, and prints
 * what each one decided.
 *
 * ## Two properties that make it safe to point at production
 *
 * **It only reads.** No write, no upsert, no audit row — so unlike the other
 * scripts here it does *not* refuse to run when `NODE_ENV=production`. Refusing
 * would remove it from the one database whose data is ever in question.
 *
 * **It prints business configuration, never people.** Providers, services,
 * schedules and counts. It never reads a customer, and a booking appears only
 * as an occupied interval (CLAUDE.md rule 6).
 *
 * ## What it deliberately does not do
 *
 * It does not reimplement the arithmetic. The final verdict comes from
 * `generateSlots` — the same function the API calls — so a disagreement between
 * this script and the booking page is a finding about the service layer rather
 * than about the engine. Only the plan assembly is duplicated, from
 * `apps/api/src/modules/availability/availability.service.ts`; keep the two in
 * step if the policy there changes.
 */

/** Mirrors `DEFAULT_*` in availability.service.ts. */
const DEFAULT_MINIMUM_NOTICE_MINUTES = 0;
const DEFAULT_MAXIMUM_ADVANCE_DAYS = 180;
const DEFAULT_SLOT_INTERVAL_MINUTES = 15;

const WEEKDAY_NAMES = ["", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

function flagValue(args: string[], flag: string): string | undefined {
  const at = args.indexOf(flag);
  return at === -1 ? undefined : args[at + 1];
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const slug = args[0];
  const date = args.find((arg) => /^\d{4}-\d{2}-\d{2}$/.test(arg)) ?? new Date().toISOString().slice(0, 10);
  const serviceFilter = flagValue(args, "--service");
  const providerFilter = flagValue(args, "--provider");

  if (!slug || slug.startsWith("--")) {
    console.error(
      "Usage: pnpm db:explain-availability <tenant-slug> [YYYY-MM-DD] [--service <slug>] [--provider <display name>]\n" +
        "Reads only. Prints why the public booking page does or does not offer times on that date.",
    );
    process.exit(1);
  }

  const env = loadEnv();
  const prisma = createPrismaClient({ databaseUrl: env.DATABASE_URL });

  try {
    const tenant = await prisma.tenant.findUnique({ where: { slug } });
    if (!tenant) {
      console.error(`No organization with slug ${slug}.`);
      process.exit(1);
    }

    const weekday = weekdayOf(date);
    console.log(`Organization : ${tenant.name} (${tenant.slug}) — status ${tenant.status}`);
    console.log(`Date         : ${date} (${WEEKDAY_NAMES[weekday] ?? "?"}, ISO weekday ${String(weekday)})`);
    console.log("");

    // Gate 0 — where the schedules actually are.
    //
    // Printed before anything else because of the failure it names: a tenant
    // whose `working_hours` is full while the booking page offers nothing,
    // because the rows sit on a provider the search never reaches. An archived
    // provider still has an availability screen, and a membership linked to one
    // still saves to it — so the hours land somewhere real and invisible. The
    // same goes for a live provider who was never assigned the service.
    //
    // Counting rows per provider turns "no working hours here" into "the
    // working hours are over there", which is the whole difference between a
    // dead end and a fix.
    const scheduleOwners = await prisma.workingHours.groupBy({
      by: ["providerId"],
      where: { tenantId: tenant.id },
      _count: { _all: true },
    });

    if (scheduleOwners.length === 0) {
      console.log("Working hours: none anywhere in this organization.\n");
    } else {
      const owners = await prisma.provider.findMany({
        where: { tenantId: tenant.id, id: { in: scheduleOwners.map((row) => row.providerId) } },
        select: {
          id: true,
          displayName: true,
          archivedAt: true,
          active: true,
          services: { where: { active: true }, select: { serviceId: true } },
        },
      });

      console.log("Working hours, by provider:");
      for (const row of scheduleOwners) {
        const owner = owners.find((candidate) => candidate.id === row.providerId);
        const notes: string[] = [];

        if (!owner) notes.push("provider row missing");
        else {
          if (owner.archivedAt !== null) notes.push("ARCHIVED — the search skips this provider");
          if (!owner.active) notes.push("inactive");
          if (owner.services.length === 0) notes.push("offers no active service");
        }

        console.log(
          `  ${owner?.displayName ?? row.providerId}: ${String(row._count._all)} rows${
            notes.length === 0 ? "" : `  ← ${notes.join("; ")}`
          }`,
        );
      }
      console.log("");
    }

    // Gate 1 — the service. `searchSlots` refuses an archived one outright, and
    // the public search additionally requires `active`.
    const services = await prisma.service.findMany({
      where: {
        tenantId: tenant.id,
        archivedAt: null,
        ...(serviceFilter === undefined ? {} : { slug: serviceFilter }),
      },
      orderBy: { name: "asc" },
    });

    if (services.length === 0) {
      console.log("No unarchived services. The booking page has nothing to offer.");
      return;
    }

    for (const service of services) {
      console.log(`Service: ${service.name} (${service.slug})`);
      console.log(
        `  bookable publicly: ${service.active ? "yes" : "NO — active is false, invisible to customers"}`,
      );
      console.log(
        `  duration ${String(service.durationMinutes)}m, buffers ${String(service.bufferBeforeMinutes)}m before / ${String(service.bufferAfterMinutes)}m after`,
      );
      console.log(
        `  notice ${service.minimumNoticeMinutes === null ? "inherit" : `${String(service.minimumNoticeMinutes)}m`}, advance ${service.maximumAdvanceDays === null ? "inherit" : `${String(service.maximumAdvanceDays)} days`}`,
      );

      // Gate 2 — providers who actually offer it. An assignment inactive at
      // either end is not an offer, and this is the gate the "Who" step of the
      // booking page has already passed if a provider appeared there.
      const assignments = await prisma.providerService.findMany({
        where: {
          tenantId: tenant.id,
          serviceId: service.id,
          active: true,
          provider: {
            archivedAt: null,
            ...(providerFilter === undefined ? {} : { displayName: providerFilter }),
          },
        },
        include: { provider: true },
      });

      if (assignments.length === 0) {
        console.log("  → No active provider assignment. This is why there are no slots.\n");
        continue;
      }

      for (const assignment of assignments) {
        const provider = assignment.provider;
        console.log(`  Provider: ${provider.displayName}`);

        const publicBlockers: string[] = [];
        if (!provider.active) publicBlockers.push("active is false");
        if (!provider.onlineBookingEnabled) publicBlockers.push("onlineBookingEnabled is false");
        if (!service.active) publicBlockers.push("the service is not active");

        console.log(
          `    visible to customers: ${publicBlockers.length === 0 ? "yes" : `NO — ${publicBlockers.join(", ")}`}`,
        );
        console.log(`    timezone: ${provider.timezone}`);

        // Gate 3 — the effective window. The most restrictive value wins in
        // each direction; NULL means inherit and never constrains.
        const notice = mostRestrictive(
          [provider.minimumNoticeMinutes, service.minimumNoticeMinutes],
          Math.max,
          DEFAULT_MINIMUM_NOTICE_MINUTES,
        );
        const advance = mostRestrictive(
          [provider.maximumAdvanceDays, service.maximumAdvanceDays],
          Math.min,
          DEFAULT_MAXIMUM_ADVANCE_DAYS,
        );
        const duration = assignment.customDurationMinutes ?? service.durationMinutes;
        const required = duration + service.bufferBeforeMinutes + service.bufferAfterMinutes;

        console.log(
          `    effective notice ${String(notice)}m, advance ${String(advance)} days${
            advance < 7 ? "  ← anything further out than this is empty by policy" : ""
          }`,
        );
        console.log(
          `    duration ${String(duration)}m${assignment.customDurationMinutes === null ? "" : " (per-provider override)"}, so a working period must hold ${String(required)}m unbroken`,
        );

        // Gate 4 — the schedule. `activeOnly: true` in the search, so an
        // unticked period is invisible to booking while still shown in the
        // availability editor.
        const hours = await prisma.workingHours.findMany({
          where: { tenantId: tenant.id, providerId: provider.id },
          orderBy: [{ weekday: "asc" }, { startTime: "asc" }],
        });

        if (hours.length === 0) {
          console.log("    → No working hours at all. This is why there are no slots.\n");
          continue;
        }

        const onThisWeekday = hours.filter((row) => row.weekday === weekday);
        console.log(
          `    working hours: ${String(hours.length)} rows across the week, ${String(onThisWeekday.length)} on ${WEEKDAY_NAMES[weekday] ?? "?"}`,
        );

        for (const row of onThisWeekday) {
          const validFrom = row.validFrom ? row.validFrom.toISOString().slice(0, 10) : null;
          const validUntil = row.validUntil ? row.validUntil.toISOString().slice(0, 10) : null;
          const reasons: string[] = [];

          if (!row.active) reasons.push("row is inactive");
          if (validFrom !== null && date < validFrom) reasons.push(`starts ${validFrom}`);
          if (validUntil !== null && date > validUntil) reasons.push(`ended ${validUntil}`);

          const minutes = spanMinutes(row.startTime, row.endTime);
          if (minutes < required) reasons.push(`only ${String(minutes)}m long, needs ${String(required)}m`);

          console.log(
            `      ${row.startTime}–${row.endTime}${row.locationId === null ? "" : " (at one location)"} — ${
              reasons.length === 0 ? "applies" : `IGNORED: ${reasons.join("; ")}`
            }`,
          );
        }

        // Gate 5 — one-off closures and openings on the day.
        const from = new Date(`${date}T00:00:00Z`);
        const to = new Date(`${date}T00:00:00Z`);
        from.setUTCDate(from.getUTCDate() - 2);
        to.setUTCDate(to.getUTCDate() + 2);

        const exceptions = await prisma.availabilityException.findMany({
          where: {
            tenantId: tenant.id,
            providerId: provider.id,
            startAt: { lt: to },
            endAt: { gt: from },
          },
        });

        for (const exception of exceptions) {
          console.log(
            `      exception ${exception.type} ${exception.startAt.toISOString()} → ${exception.endAt.toISOString()}`,
          );
        }

        const reservations = await prisma.capacityReservation.findMany({
          where: {
            tenantId: tenant.id,
            providerId: provider.id,
            status: "ACTIVE",
            startAt: { lt: to },
            endAt: { gt: from },
            OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
          },
          select: { bookingId: true, startAt: true, endAt: true },
        });

        console.log(`      ${String(reservations.length)} reservation(s) occupying time near this date`);

        // The verdict, from the engine itself rather than from anything here.
        const slots = generateSlots({
          providerId: provider.id,
          serviceDurationMinutes: duration,
          bufferBeforeMinutes: service.bufferBeforeMinutes,
          bufferAfterMinutes: service.bufferAfterMinutes,
          dateFrom: date,
          dateTo: date,
          timezone: provider.timezone,
          slotIntervalMinutes: DEFAULT_SLOT_INTERVAL_MINUTES,
          workingPeriods: hours.filter((row) => row.active).map(toTimePeriod),
          additionalPeriods: exceptions
            .filter((row) => row.type === "ADDITIONAL_AVAILABILITY")
            .map((row) => ({ startAt: row.startAt.toISOString(), endAt: row.endAt.toISOString() })),
          unavailablePeriods: exceptions
            .filter((row) => row.type === "UNAVAILABLE")
            .map((row) => ({ startAt: row.startAt.toISOString(), endAt: row.endAt.toISOString() })),
          bookings: reservations
            .filter((row) => row.bookingId !== null)
            .map((row) => ({ startAt: row.startAt.toISOString(), endAt: row.endAt.toISOString() })),
          activeHolds: reservations
            .filter((row) => row.bookingId === null)
            .map((row) => ({ startAt: row.startAt.toISOString(), endAt: row.endAt.toISOString() })),
          externalBusyPeriods: [],
          minimumNoticeMinutes: notice,
          maximumAdvanceDays: advance,
          now: new Date().toISOString(),
        });

        console.log(
          `    → engine offers ${String(slots.length)} slot(s)${
            slots.length === 0 ? "" : `, first at ${slots[0]?.startAt ?? "?"}`
          }\n`,
        );
      }
    }
  } finally {
    await prisma.$disconnect();
  }
}

/** NULL means inherit, so it never constrains. Mirrors the service's two helpers. */
function mostRestrictive(
  values: (number | null)[],
  pick: (...numbers: number[]) => number,
  fallback: number,
): number {
  const set = values.filter((value): value is number => value !== null);
  return set.length === 0 ? fallback : pick(...set);
}

/** Wall-clock minutes between two `HH:mm` strings, `24:00` and overnight included. */
function spanMinutes(startTime: string, endTime: string): number {
  const start = toMinutes(startTime);
  const end = toMinutes(endTime);
  return end <= start ? end + 1440 - start : end - start;
}

function toMinutes(time: string): number {
  const [hours, minutes] = time.split(":");
  return Number(hours) * 60 + Number(minutes);
}

function toTimePeriod(row: {
  weekday: number;
  startTime: string;
  endTime: string;
  validFrom: Date | null;
  validUntil: Date | null;
}): TimePeriod {
  return {
    weekday: row.weekday,
    startTime: row.startTime,
    endTime: row.endTime,
    ...(row.validFrom === null ? {} : { validFrom: row.validFrom.toISOString().slice(0, 10) }),
    ...(row.validUntil === null ? {} : { validUntil: row.validUntil.toISOString().slice(0, 10) }),
  };
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
