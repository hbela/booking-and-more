import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPrismaClient, type PrismaClient } from "@bam/db";
import { createLogger } from "@bam/observability";

import { sweepConversations } from "./conversation.sweeper.js";

/**
 * docs/phase-8-push-to-talk-voice.md §4.
 *
 * The pass that matters is the third one. A customer who closes the tab
 * mid-booking leaves a slot nobody can take, and a conversation's window is
 * thirty minutes against the hold's five — so without this the diary loses an
 * hour every time somebody wanders off.
 */

const databaseUrl = process.env["TEST_DATABASE_URL"];

const RUN = `sw${randomBytes(4).toString("hex")}`;
const logger = createLogger({ service: "worker", level: "silent" });

describe.skipIf(!databaseUrl)("conversation sweeper", () => {
  let prisma: PrismaClient;
  let tenantId: string;
  let providerId: string;
  let serviceId: string;

  beforeAll(async () => {
    prisma = createPrismaClient({ databaseUrl: databaseUrl! });

    const tenant = await prisma.tenant.create({
      data: { slug: `sweep-${RUN}`, name: "Sweep clinic", status: "ACTIVE" },
    });
    tenantId = tenant.id;

    const provider = await prisma.provider.create({
      data: { tenantId, displayName: "Dr. Sweep", timezone: "UTC" },
    });
    providerId = provider.id;

    const service = await prisma.service.create({
      data: { tenantId, name: "Consultation", slug: `consultation-${RUN}`, durationMinutes: 60 },
    });
    serviceId = service.id;
  });

  afterAll(async () => {
    const where = { tenantId };
    await prisma.voiceInteraction.deleteMany({ where });
    await prisma.conversationPendingAction.deleteMany({ where });
    await prisma.conversationMessage.deleteMany({ where });
    await prisma.conversationSession.deleteMany({ where });
    await prisma.capacityReservation.deleteMany({ where });
    await prisma.bookingHold.deleteMany({ where });
    await prisma.service.deleteMany({ where });
    await prisma.provider.deleteMany({ where });
    await prisma.tenant.delete({ where: { id: tenantId } });
    await prisma.$disconnect();
  });

  const now = new Date("2026-08-10T12:00:00Z");

  async function conversation(args: {
    expiresAt: Date;
    withHold?: boolean;
  }): Promise<{ id: string; holdId: string | null }> {
    let holdId: string | null = null;

    if (args.withHold === true) {
      const hold = await prisma.bookingHold.create({
        data: {
          tenantId,
          providerId,
          serviceId,
          sessionId: `conv-${randomBytes(4).toString("hex")}`,
          startAt: new Date("2026-09-07T09:00:00Z"),
          endAt: new Date("2026-09-07T10:00:00Z"),
          expiresAt: new Date("2026-09-07T08:00:00Z"),
        },
      });

      await prisma.capacityReservation.create({
        data: {
          tenantId,
          providerId,
          holdId: hold.id,
          startAt: hold.startAt,
          endAt: hold.endAt,
          expiresAt: hold.expiresAt,
        },
      });

      holdId = hold.id;
    }

    const session = await prisma.conversationSession.create({
      data: {
        tenantId,
        locale: "hu",
        timezone: "Europe/Budapest",
        machineState: "SELECTING_SLOT",
        tokenHash: randomBytes(16).toString("hex"),
        expiresAt: args.expiresAt,
        ...(holdId === null ? {} : { holdId }),
      },
    });

    return { id: session.id, holdId };
  }

  function sweep(overrides: { now?: Date } = {}) {
    return sweepConversations({
      prisma,
      logger,
      transcriptRetentionDays: 30,
      batchSize: 100,
      now: overrides.now ?? now,
    });
  }

  it("expires a conversation past its deadline and leaves a live one alone", async () => {
    const stale = await conversation({ expiresAt: new Date("2026-08-10T11:00:00Z") });
    const live = await conversation({ expiresAt: new Date("2026-08-10T12:30:00Z") });

    const summary = await sweep();
    expect(summary.sessionsExpired).toBeGreaterThanOrEqual(1);

    const rows = await prisma.conversationSession.findMany({
      where: { id: { in: [stale.id, live.id] } },
    });

    expect(rows.find((row) => row.id === stale.id)?.status).toBe("EXPIRED");
    expect(rows.find((row) => row.id === live.id)?.status).toBe("ACTIVE");
  });

  it("gives back the slot an abandoned conversation was holding", async () => {
    const abandoned = await conversation({
      expiresAt: new Date("2026-08-10T11:00:00Z"),
      withHold: true,
    });

    const summary = await sweep();
    expect(summary.holdsReleased).toBeGreaterThanOrEqual(1);

    const hold = await prisma.bookingHold.findUniqueOrThrow({ where: { id: abandoned.holdId! } });
    expect(hold.status).toBe("RELEASED");

    // The reservation is what actually blocks the slot; a released hold with a
    // live reservation would leave the diary exactly as full as before.
    const reservation = await prisma.capacityReservation.findFirstOrThrow({
      where: { holdId: abandoned.holdId! },
    });
    expect(reservation.status).toBe("RELEASED");
  });

  it("leaves a hold that already became something else alone", async () => {
    const abandoned = await conversation({
      expiresAt: new Date("2026-08-10T11:00:00Z"),
      withHold: true,
    });

    await prisma.bookingHold.update({
      where: { id: abandoned.holdId! },
      data: { status: "CONFIRMED" },
    });

    await sweep();

    const hold = await prisma.bookingHold.findUniqueOrThrow({ where: { id: abandoned.holdId! } });
    expect(hold.status).toBe("CONFIRMED");
  });

  it("expires a pending action past its own deadline", async () => {
    const session = await conversation({ expiresAt: new Date("2026-08-10T12:30:00Z") });

    const action = await prisma.conversationPendingAction.create({
      data: {
        tenantId,
        sessionId: session.id,
        toolName: "confirmBooking",
        argumentsJson: {},
        previewJson: {},
        expiresAt: new Date("2026-08-10T11:59:00Z"),
      },
    });

    const summary = await sweep();
    expect(summary.actionsExpired).toBeGreaterThanOrEqual(1);

    const row = await prisma.conversationPendingAction.findUniqueOrThrow({
      where: { id: action.id },
    });
    expect(row.status).toBe("EXPIRED");
  });

  it("erases an old transcript and keeps the row that priced it", async () => {
    const session = await conversation({ expiresAt: new Date("2026-08-10T12:30:00Z") });

    const old = await prisma.voiceInteraction.create({
      data: {
        tenantId,
        sessionId: session.id,
        audioDurationMs: 5_000,
        transcriptionProvider: "openai",
        transcriptionModel: "gpt-4o-mini-transcribe",
        transcript: "valamit mondtam",
        estimatedCostMinor: 1,
        createdAt: new Date("2026-06-01T09:00:00Z"),
      },
    });

    const recent = await prisma.voiceInteraction.create({
      data: {
        tenantId,
        sessionId: session.id,
        audioDurationMs: 5_000,
        transcriptionProvider: "openai",
        transcriptionModel: "gpt-4o-mini-transcribe",
        transcript: "ez még friss",
        estimatedCostMinor: 1,
        createdAt: new Date("2026-08-09T09:00:00Z"),
      },
    });

    const summary = await sweep();
    expect(summary.transcriptsErased).toBeGreaterThanOrEqual(1);

    const erased = await prisma.voiceInteraction.findUniqueOrThrow({ where: { id: old.id } });
    expect(erased.transcript).toBeNull();
    // The row survives: deleting the duration and cost would make a month's
    // spend unreconcilable.
    expect(erased.audioDurationMs).toBe(5_000);
    expect(erased.estimatedCostMinor).toBe(1);

    const kept = await prisma.voiceInteraction.findUniqueOrThrow({ where: { id: recent.id } });
    expect(kept.transcript).toBe("ez még friss");
  });
});
