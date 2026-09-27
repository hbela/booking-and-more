import { hasAssistantEntitlement, ErrorCodes, NotFoundError } from "@bam/contracts";
import type { CollectedFields } from "@bam/conversation-engine";
import type {
  ConversationChannel,
  ConversationMessage,
  ConversationPendingAction,
  ConversationSession,
  Prisma,
  PrismaClient,
} from "@bam/db";

import { hashToken } from "../bookings/booking.repository.js";
import type { conversationSlotSchema } from "./conversation.schemas.js";
import type { z } from "zod";

/**
 * What `state_json` holds: the engine's collected fields, plus the list the
 * customer was last shown.
 *
 * The slot list lives here rather than in the engine's `CollectedFields` because
 * it is not something the conversation has *decided* — it is what is currently
 * on screen, and it exists so that "the second one" resolves against what the
 * customer can actually see rather than against the model's recollection.
 */
export type StoredConversationState = CollectedFields & {
  lastSlots?: z.infer<typeof conversationSlotSchema>[];
};

/**
 * Rows in, rows out. docs/phase-7-chat-booking.md §3, §5.
 *
 * Every method takes `tenantId` (rule 5) except the two that resolve a
 * conversation from its token — those *establish* which tenant is in play, which
 * is the same shape as `findByManagementToken` on the booking side, and they
 * scope every subsequent call by what they found.
 */

import { chatMonthlyLimit, chatLimitError, type ChatLimits } from "./chat-guards.js";

export type ConversationWithTenant = ConversationSession;

export class ConversationRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Mint a conversation and its token.
   *
   * Identical start keys reproduce the opaque token. Only its SHA-256 hash is stored, the same
   * construction as a booking's management token — a database dump must not be a
   * set of live credentials.
   */
  async create(args: {
    token: string;
    startKeyHash: string;
    startRequestHash: string;
    limits: ChatLimits;
    now: Date;
    tenantId: string;
    channel: ConversationChannel;
    locale: string;
    timezone: string;
    machineState: string;
    expiresAt: Date;
    bookingId?: string | undefined;
    customerId?: string | undefined;
  }): Promise<{ session: ConversationSession; token: string; replayed: boolean }> {
    const token = args.token;
    return this.prisma.$transaction(async (tx) => {
      const lock = "chat-admission:" + args.tenantId;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lock}, 0))`;
      const existing = await tx.conversationSession.findUnique({
        where: {
          tenantId_startKeyHash: { tenantId: args.tenantId, startKeyHash: args.startKeyHash },
        },
      });
      if (existing) {
        if (existing.startRequestHash !== args.startRequestHash)
          throw chatLimitError("This start key belongs to another request.", 409);
        return { session: existing, token, replayed: true };
      }
      const subscription = await tx.subscription.findUnique({ where: { tenantId: args.tenantId } });
      if (!hasAssistantEntitlement(subscription?.plan, subscription?.status))
        throw chatLimitError("Chat is unavailable. Please use the booking form.", 403);
      const monthly = chatMonthlyLimit(subscription!.plan, args.limits);
      if (monthly !== null) {
        for (const [period, limit] of [
          [args.now.toISOString().slice(0, 10), args.limits.dailyLimit],
          [args.now.toISOString().slice(0, 7), monthly],
        ] as const) {
          const where = { tenantId_period: { tenantId: args.tenantId, period } };
          const counter = await tx.chatUsageCounter.findUnique({ where });
          if ((counter?.quantity ?? 0) >= limit)
            throw chatLimitError("The chat allowance has been used. Please use the booking form.");
          await tx.chatUsageCounter.upsert({
            where,
            create: { tenantId: args.tenantId, period, quantity: 1 },
            update: { quantity: { increment: 1 } },
          });
        }
      }
      const session = await tx.conversationSession.create({
        data: {
          tenantId: args.tenantId,
          channel: args.channel,
          locale: args.locale,
          timezone: args.timezone,
          machineState: args.machineState,
          tokenHash: hashToken(token),
          startKeyHash: args.startKeyHash,
          startRequestHash: args.startRequestHash,
          createdAt: args.now,
          expiresAt: args.expiresAt,
          ...(args.bookingId === undefined ? {} : { bookingId: args.bookingId }),
          ...(args.customerId === undefined ? {} : { customerId: args.customerId }),
        },
      });

      return { session, token, replayed: false };
    });
  }

  /**
   * The conversation this token opens, or nothing.
   *
   * Deliberately returns `null` rather than throwing, so the caller can collapse
   * every failure into one 404 (see `conversationNotFound`). Distinguishing "no
   * such id" from "wrong token" would turn the endpoint into an oracle for
   * which conversation ids exist.
   */
  async findByToken(args: {
    conversationId: string;
    token: string;
  }): Promise<ConversationSession | null> {
    const session = await this.prisma.conversationSession.findUnique({
      where: { id: args.conversationId },
    });

    if (!session) return null;
    if (session.tokenHash !== hashToken(args.token)) return null;
    // Authenticated expired sessions remain readable; write gates enforce expiry.

    return session;
  }

  /**
   * The data type is the *unchecked many* one, and deliberately not cast to it.
   *
   * `updateMany` cannot write relations, only scalars — so `booking: { connect }`
   * compiles against `UpdateInput` and fails at runtime with "Unknown argument".
   * Naming the type the query actually accepts moves that from a test failure to
   * a compile error, and means a foreign key is set as `bookingId`, which is
   * what the column is called anyway.
   */
  async update(args: {
    tenantId: string;
    conversationId: string;
    data: Prisma.ConversationSessionUncheckedUpdateManyInput;
  }): Promise<ConversationSession> {
    // Scoped by tenant as well as id, so a mis-plumbed caller cannot write
    // across a tenant boundary even though the id alone is unique.
    const { count } = await this.prisma.conversationSession.updateMany({
      where: { id: args.conversationId, tenantId: args.tenantId },
      data: args.data,
    });

    if (count === 0) throw conversationNotFound();

    return this.prisma.conversationSession.findUniqueOrThrow({
      where: { id: args.conversationId },
    });
  }

  /** The collected fields, as the engine's shape rather than as JSON. */
  collectedOf(session: ConversationSession): StoredConversationState {
    return (session.stateJson ?? {}) as StoredConversationState;
  }

  async appendMessage(args: {
    tenantId: string;
    conversationId: string;
    sender: "CUSTOMER" | "ASSISTANT" | "SYSTEM";
    messageType: "TEXT" | "STRUCTURED";
    content: string;
    structured?: Prisma.InputJsonValue | undefined;
  }): Promise<ConversationMessage> {
    return this.prisma.conversationMessage.create({
      data: {
        tenantId: args.tenantId,
        sessionId: args.conversationId,
        sender: args.sender,
        messageType: args.messageType,
        content: args.content,
        ...(args.structured === undefined ? {} : { structuredContentJson: args.structured }),
      },
    });
  }

  async messages(args: {
    tenantId: string;
    conversationId: string;
    limit?: number;
  }): Promise<ConversationMessage[]> {
    return this.prisma.conversationMessage.findMany({
      where: { tenantId: args.tenantId, sessionId: args.conversationId },
      orderBy: { createdAt: "asc" },
      take: args.limit ?? 200,
    });
  }

  // --- Pending actions ------------------------------------------------------

  async createPendingAction(args: {
    tenantId: string;
    conversationId: string;
    toolName: string;
    /** Validated arguments — already through the intent's parameter schema. */
    args: Record<string, unknown>;
    preview: Record<string, unknown>;
    expiresAt: Date;
  }): Promise<ConversationPendingAction> {
    // One live offer per conversation. A customer who is shown a new card has
    // moved on from the old one, and leaving it confirmable is how a "yes"
    // lands on the wrong appointment.
    await this.prisma.conversationPendingAction.updateMany({
      where: { sessionId: args.conversationId, status: "PENDING" },
      data: { status: "CANCELLED" },
    });

    return this.prisma.conversationPendingAction.create({
      data: {
        tenantId: args.tenantId,
        sessionId: args.conversationId,
        toolName: args.toolName,
        // The one place a plain object becomes Prisma's JSON type. Both values
        // have already been validated; `InputJsonValue` is a structural type
        // TypeScript cannot infer an index signature into.
        argumentsJson: args.args as Prisma.InputJsonValue,
        previewJson: args.preview as Prisma.InputJsonValue,
        expiresAt: args.expiresAt,
      },
    });
  }

  async findPendingAction(args: {
    tenantId: string;
    actionId: string;
  }): Promise<ConversationPendingAction | null> {
    return this.prisma.conversationPendingAction.findFirst({
      where: { id: args.actionId, tenantId: args.tenantId },
    });
  }

  async liveActionFor(args: {
    tenantId: string;
    conversationId: string;
  }): Promise<ConversationPendingAction | null> {
    return this.prisma.conversationPendingAction.findFirst({
      where: { tenantId: args.tenantId, sessionId: args.conversationId, status: "PENDING" },
      orderBy: { createdAt: "desc" },
    });
  }

  /**
   * Burn the action.
   *
   * Conditional on it still being PENDING, so two confirmations racing produce
   * one winner and one `count === 0` — the same shape as the unique index that
   * decides an invitation race in phase-9-provider-onboarding §2.7. Application
   * code translates; the database decides.
   */
  async settleAction(args: {
    tenantId: string;
    actionId: string;
    status: "CONFIRMED" | "CANCELLED";
    now: Date;
  }): Promise<boolean> {
    const { count } = await this.prisma.conversationPendingAction.updateMany({
      where: { id: args.actionId, tenantId: args.tenantId, status: "PENDING" },
      data: {
        status: args.status,
        ...(args.status === "CONFIRMED" ? { confirmedAt: args.now } : {}),
      },
    });

    return count === 1;
  }

  // --- Voice ----------------------------------------------------------------

  recordVoiceInteraction(args: {
    tenantId: string;
    conversationId: string;
    audioDurationMs: number;
    provider: string;
    model: string;
    transcript: string;
    detectedLanguage?: string | undefined;
    estimatedCostMinor: number;
  }): Promise<void> {
    // Voice has no public route in the text-chat v1 and no audio/transcript
    // table is created. Keep the interface inert for the reusable engine seam.
    void args;
    return Promise.resolve();
  }
}

/**
 * One 404 for every way a conversation can fail to resolve: unknown id, wrong
 * token, expired session, another tenant's conversation. The same reasoning as
 * `bookingLinkNotFound` — a token is a credential, and telling a prober which of
 * their guesses was half right is how they finish guessing.
 */
export function conversationNotFound(): NotFoundError {
  return new NotFoundError(
    "This conversation is no longer available.",
    ErrorCodes.CONVERSATION_NOT_FOUND,
  );
}
