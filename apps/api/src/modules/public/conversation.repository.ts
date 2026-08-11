import { ErrorCodes, NotFoundError } from "@bam/contracts";
import type { CollectedFields } from "@bam/conversation-engine";
import type {
  ConversationChannel,
  ConversationMessage,
  ConversationPendingAction,
  ConversationSession,
  Prisma,
  PrismaClient,
} from "@bam/db";

import { createManagementToken, hashToken } from "../bookings/booking.repository.js";
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

export type ConversationWithTenant = ConversationSession;

export class ConversationRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Mint a conversation and its token.
   *
   * The token is returned once. Only its SHA-256 hash is stored, the same
   * construction as a booking's management token — a database dump must not be a
   * set of live credentials.
   */
  async create(args: {
    tenantId: string;
    channel: ConversationChannel;
    locale: string;
    timezone: string;
    machineState: string;
    expiresAt: Date;
  }): Promise<{ session: ConversationSession; token: string }> {
    const { token, hash } = createManagementToken();

    const session = await this.prisma.conversationSession.create({
      data: {
        tenantId: args.tenantId,
        channel: args.channel,
        locale: args.locale,
        timezone: args.timezone,
        machineState: args.machineState,
        tokenHash: hash,
        expiresAt: args.expiresAt,
      },
    });

    return { session, token };
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
    messageType: "TEXT" | "VOICE" | "STRUCTURED";
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

  async recordVoiceInteraction(args: {
    tenantId: string;
    conversationId: string;
    audioDurationMs: number;
    provider: string;
    model: string;
    transcript: string;
    detectedLanguage?: string | undefined;
    estimatedCostMinor: number;
  }): Promise<void> {
    await this.prisma.voiceInteraction.create({
      data: {
        tenantId: args.tenantId,
        sessionId: args.conversationId,
        audioDurationMs: args.audioDurationMs,
        transcriptionProvider: args.provider,
        transcriptionModel: args.model,
        transcript: args.transcript,
        ...(args.detectedLanguage === undefined
          ? {}
          : { detectedLanguage: args.detectedLanguage }),
        estimatedCostMinor: args.estimatedCostMinor,
        // Retention is off, so nothing was stored to retain
        // (docs/phase-8-push-to-talk-voice.md §4).
        audioRetained: false,
      },
    });
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
