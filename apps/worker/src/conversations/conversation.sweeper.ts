import type { PrismaClient } from "@bam/db";
import type { Logger } from "@bam/observability";

/**
 * Expiry and retention for conversations.
 * tech-impl §26.2, §35 · docs/phase-8-push-to-talk-voice.md §4.
 *
 * Four passes, and they are separate because they answer different questions:
 *
 *   1. **Sessions past their deadline** become EXPIRED. Nothing depends on this
 *      for correctness — `checkTurnAllowed` reads the clock, so an expired
 *      conversation is refused on the request that finds it rather than on the
 *      one after the sweep. What this gives is an honest `status` column, which
 *      is what anybody looking at the table will believe.
 *   2. **Pending actions past theirs**, for the same reason.
 *   3. **Holds an abandoned conversation is still carrying** are released. This
 *      one *does* matter: a customer who closes the tab mid-booking leaves a
 *      slot nobody can take, and the hold's own expiry is five minutes while a
 *      conversation's is thirty.
 *   4. **Transcripts past the retention window** are nulled. The row survives —
 *      it carries the duration and cost a month's usage figures were built from,
 *      and deleting those would make the spend unreconcilable.
 *
 * There is no pass for deleting audio. With retention off the buffer goes
 * straight to the provider and is dropped, so there is nothing to delete: the
 * cheapest possible implementation of a retention rule is not storing the thing.
 */

export interface ConversationSweepOptions {
  prisma: PrismaClient;
  logger: Logger;
  /** tech-impl §35: transcripts live 30 days by default. */
  transcriptRetentionDays: number;
  batchSize: number;
  now?: Date;
}

export interface ConversationSweepSummary {
  sessionsExpired: number;
  actionsExpired: number;
  holdsReleased: number;
  transcriptsErased: number;
}

export async function sweepConversations(
  options: ConversationSweepOptions,
): Promise<ConversationSweepSummary> {
  const now = options.now ?? new Date();
  const { prisma } = options;

  // Read the abandoned sessions before expiring them: the update loses the
  // `holdId` list, and releasing the holds is the pass that actually matters.
  const abandoned = await prisma.conversationSession.findMany({
    where: { status: "ACTIVE", expiresAt: { lte: now }, holdId: { not: null } },
    select: { id: true, tenantId: true, holdId: true },
    take: options.batchSize,
  });

  const { count: sessionsExpired } = await prisma.conversationSession.updateMany({
    where: { status: "ACTIVE", expiresAt: { lte: now } },
    data: { status: "EXPIRED", machineState: "EXPIRED" },
  });

  const { count: actionsExpired } = await prisma.conversationPendingAction.updateMany({
    where: { status: "PENDING", expiresAt: { lte: now } },
    data: { status: "EXPIRED" },
  });

  let holdsReleased = 0;

  for (const session of abandoned) {
    if (session.holdId === null) continue;

    // Conditional on the hold still being ACTIVE, so a hold that has already
    // become a booking — or already expired on its own five-minute clock — is
    // left alone. The count is what makes that decision, not a prior read.
    const { count } = await prisma.bookingHold.updateMany({
      where: { id: session.holdId, tenantId: session.tenantId, status: "ACTIVE" },
      data: { status: "RELEASED" },
    });

    holdsReleased += count;

    if (count > 0) {
      await prisma.capacityReservation.updateMany({
        where: { holdId: session.holdId, tenantId: session.tenantId, status: "ACTIVE" },
        data: { status: "RELEASED" },
      });
    }
  }

  const retentionCutoff = new Date(
    now.getTime() - options.transcriptRetentionDays * 24 * 60 * 60 * 1_000,
  );

  const transcriptsErased = await prisma.$executeRaw`
    WITH eligible AS (
      SELECT "id" FROM "conversation_messages"
      WHERE "created_at" <= ${retentionCutoff} AND "redacted_at" IS NULL
      ORDER BY "created_at" ASC
      LIMIT ${options.batchSize}
    )
    UPDATE "conversation_messages"
    SET "content" = '[redacted]', "structured_content_json" = NULL,
        "input_tokens" = NULL, "output_tokens" = NULL, "redacted_at" = ${now}
    WHERE "id" IN (SELECT "id" FROM eligible)
  `;

  await prisma.conversationSession.updateMany({
    where: { createdAt: { lte: retentionCutoff }, summary: { not: null } },
    data: { summary: null },
  });

  await prisma.$executeRaw`
    WITH eligible AS (
      SELECT "id" FROM "conversation_pending_actions"
      WHERE "created_at" <= ${retentionCutoff}
        AND ("arguments_json" <> '{}'::jsonb OR "preview_json" <> '{}'::jsonb)
      ORDER BY "created_at" ASC
      LIMIT ${options.batchSize}
    )
    UPDATE "conversation_pending_actions"
    SET "arguments_json" = '{}'::jsonb, "preview_json" = '{}'::jsonb
    WHERE "id" IN (SELECT "id" FROM eligible)
  `;

  return { sessionsExpired, actionsExpired, holdsReleased, transcriptsErased };
}

export interface ConversationSweeper {
  stop: () => Promise<void>;
}

export interface ConversationSweeperOptions extends ConversationSweepOptions {
  intervalMs: number;
}

export function startConversationSweeper(
  options: ConversationSweeperOptions,
): ConversationSweeper {
  let stopped = false;
  let inFlight: Promise<void> = Promise.resolve();

  const runPass = async (): Promise<void> => {
    try {
      const summary = await sweepConversations(options);

      if (Object.values(summary).some((count) => count > 0)) {
        options.logger.info({ ...summary }, "conversations: swept");
      }
    } catch (error) {
      // The rows are still there; log and let the next tick try again.
      options.logger.error({ err: error }, "conversations: sweep failed");
    }
  };

  const tick = (): void => {
    if (stopped) return;
    inFlight = runPass();
  };

  const timer = setInterval(tick, options.intervalMs);
  tick();

  return {
    stop: async () => {
      stopped = true;
      clearInterval(timer);
      await inFlight;
    },
  };
}
