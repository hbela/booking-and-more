import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPrismaClient, type PrismaClient } from "./index.js";

/**
 * Instants stored as instants.
 *
 * node-postgres serialises a JS `Date` as its UTC digits with no offset, and
 * PostgreSQL reads that literal in the session `TimeZone`. Unless the session
 * is UTC, the stored instant is shifted by the local offset — and because reads
 * shift back by the same amount, a Prisma round-trip returns exactly what it
 * stored. The bug is invisible from TypeScript and visible only to SQL.
 *
 * That is why these assertions go through `extract(epoch …)` rather than
 * comparing Dates: the epoch is what PostgreSQL itself will compare when it
 * evaluates `available_at <= now()`, and the epoch is the thing that was wrong.
 *
 * The failure this prevents is worse than a fixed two-hour skew, because the
 * offset changes with daylight saving: outbox events scheduled in July fire two
 * hours early, the same code in January is one hour out, and nothing in the
 * application changed in between. Related: CLAUDE.md rule 13.
 */

const databaseUrl = process.env["TEST_DATABASE_URL"];
const suffix = Math.random().toString(36).slice(2, 10);

describe.skipIf(!databaseUrl)("timestamptz handling", () => {
  let prisma: PrismaClient;
  let tenantId: string;

  beforeAll(async () => {
    prisma = createPrismaClient({ databaseUrl: databaseUrl! });

    const tenant = await prisma.tenant.create({
      data: { slug: `tz-${suffix}`, name: "Timezone Clinic" },
    });
    tenantId = tenant.id;
  });

  afterAll(async () => {
    await prisma.outboxEvent.deleteMany({ where: { tenantId } });
    await prisma.tenant.deleteMany({ where: { id: tenantId } });
    await prisma.$disconnect();
  });

  it("runs sessions in UTC", async () => {
    const [row] = await prisma.$queryRawUnsafe<{ tz: string }[]>(
      "SELECT current_setting('TimeZone') AS tz",
    );

    expect(row?.tz).toBe("UTC");
  });

  it("stores the instant it was given, not its wall-clock digits", async () => {
    const intended = new Date("2026-07-29T10:00:00.000Z");

    const event = await prisma.outboxEvent.create({
      data: {
        tenantId,
        eventType: "PROBE",
        aggregateType: "Probe",
        aggregateId: `instant-${suffix}`,
        payload: {},
        availableAt: intended,
      },
    });

    const [stored] = await prisma.$queryRawUnsafe<{ epoch: number }[]>(
      `SELECT extract(epoch from available_at)::float8 AS epoch
       FROM outbox_events WHERE id = '${event.id}'`,
    );

    expect(Number(stored?.epoch)).toBe(intended.getTime() / 1_000);
  });

  it("agrees with the database about whether a future timestamp is due", async () => {
    // The dispatcher's claim predicate, in miniature. This is the assertion
    // that failed before the session was pinned to UTC.
    const oneHourAhead = new Date(Date.now() + 60 * 60 * 1_000);

    const event = await prisma.outboxEvent.create({
      data: {
        tenantId,
        eventType: "PROBE",
        aggregateType: "Probe",
        aggregateId: `due-${suffix}`,
        payload: {},
        availableAt: oneHourAhead,
      },
    });

    const [row] = await prisma.$queryRawUnsafe<{ is_due: boolean }[]>(
      `SELECT (available_at <= now()) AS is_due FROM outbox_events WHERE id = '${event.id}'`,
    );

    expect(row?.is_due).toBe(false);
  });

  it("agrees that a past timestamp is due", async () => {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1_000);

    const event = await prisma.outboxEvent.create({
      data: {
        tenantId,
        eventType: "PROBE",
        aggregateType: "Probe",
        aggregateId: `past-${suffix}`,
        payload: {},
        availableAt: oneHourAgo,
      },
    });

    const [row] = await prisma.$queryRawUnsafe<{ is_due: boolean }[]>(
      `SELECT (available_at <= now()) AS is_due FROM outbox_events WHERE id = '${event.id}'`,
    );

    expect(row?.is_due).toBe(true);
  });

  it("keeps the database clock and the process clock in agreement", async () => {
    const [row] = await prisma.$queryRawUnsafe<{ epoch: number }[]>(
      "SELECT extract(epoch from now())::float8 AS epoch",
    );

    // Generous: this asserts there is no timezone-sized discrepancy, not that
    // the clocks are synchronised to the millisecond.
    expect(Math.abs(Number(row?.epoch) - Date.now() / 1_000)).toBeLessThan(60);
  });
});
