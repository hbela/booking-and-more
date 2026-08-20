import type { AiProviders, ConversationTurn } from "@bam/ai";
import { parseCommand, type ConversationIntent } from "@bam/contracts";
import {
  checkPendingActionUsable,
  checkTurnAllowed,
  conversationExpiresAt,
  greeting,
  promptFor,
  refusalMessage,
  stateFor,
  type AssistantMessage,
  type CustomerBookingState,
  type RefusalKey,
} from "@bam/conversation-engine";
import type { ConversationSession, Prisma, PrismaClient, Tenant } from "@bam/db";

import { withIdempotency } from "../../lib/idempotency.js";
interface ValidatedAudio {
  data: Uint8Array;
  durationMs: number;
  billableSeconds: number;
  contentType: string;
  filename: string;
}
import type { AuditContext } from "../bookings/booking.service.js";
import { BookingService } from "../bookings/booking.service.js";
import { BookingRepository } from "../bookings/booking.repository.js";
import { UsageService } from "../usage/usage.service.js";
import { AssistantService } from "../assistant/assistant.service.js";
import {
  ConversationRepository,
  conversationNotFound,
  type StoredConversationState,
} from "./conversation.repository.js";
import type {
  ConfirmationCard,
  ConversationTurnResponse,
  CreateConversationBody,
  conversationMessageSchema,
  conversationProviderSchema,
  conversationServiceSchema,
  conversationSlotSchema,
} from "./conversation.schemas.js";
import { ConversationTools } from "./conversation.tools.js";
import type { z } from "zod";

/**
 * One conversation, turn by turn. docs/phase-7-chat-booking.md.
 *
 * The order of a turn is fixed and each step exists to stop the next one being
 * trusted too early:
 *
 *   turn limit → quota gate → interpret → validate envelope → validate
 *   parameters → allowlist → tool → derive state → prepare → reply
 *
 * The model sits in the middle of that and touches neither end. It does not
 * decide whether the conversation may continue, it does not choose what runs,
 * and it does not write the reply.
 */

type StoredState = StoredConversationState;

/**
 * What one turn is assumed to cost before it is made.
 *
 * The gate has to authorise a spend it has not yet measured, so it authorises a
 * generous estimate and records the truth afterwards. Over-estimating is the
 * safe direction: a tenant is refused slightly early rather than slightly late,
 * and the recorded figure is always the real one.
 */
const ESTIMATED_INPUT_TOKENS = 1_500;

/** Below this the assistant asks rather than acts (PRD §9.12). */
const CONFIDENCE_FLOOR = 0.55;

export interface ConversationOptions {
  sessionTtlMinutes: number;
  maxTurns: number;
  pendingActionTtlSeconds: number;
  maxOutputTokens: number;
}

export class ConversationService {
  readonly repo: ConversationRepository;
  private readonly tools: ConversationTools;
  private readonly bookings: BookingService;
  private readonly bookingRepository: BookingRepository;
  private readonly usage: UsageService;
  private readonly assistant: AssistantService;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly providers: AiProviders,
    private readonly options: ConversationOptions,
  ) {
    this.repo = new ConversationRepository(prisma);
    this.tools = new ConversationTools(prisma);
    this.bookings = new BookingService(prisma);
    this.bookingRepository = new BookingRepository(prisma);
    this.usage = new UsageService(prisma);
    this.assistant = new AssistantService(prisma);
  }

  // --- Lifecycle ------------------------------------------------------------

  async start(args: {
    tenant: Tenant;
    input: CreateConversationBody;
    now: Date;
  }): Promise<{ response: ConversationTurnResponse; token: string; expiresAt: Date }> {
    const expiresAt = conversationExpiresAt(args.now, this.options.sessionTtlMinutes);
    const authorizedBooking =
      args.input.managementToken === undefined
        ? null
        : await this.bookingRepository.findByManagementToken(args.input.managementToken);

    // Do not reveal whether a token exists for another tenant. The credential is
    // consumed here and only the already-authorized relation ids survive.
    if (
      args.input.managementToken !== undefined &&
      (authorizedBooking === null || authorizedBooking.tenantId !== args.tenant.id)
    ) {
      throw conversationNotFound();
    }

    const { session, token } = await this.repo.create({
      tenantId: args.tenant.id,
      channel: args.input.channel,
      locale: args.input.locale,
      timezone: args.input.timezone,
      machineState: "START",
      expiresAt,
      ...(authorizedBooking === null
        ? {}
        : {
            bookingId: authorizedBooking.id,
            customerId: authorizedBooking.customerId,
          }),
    });

    const message = greeting(args.tenant.name);

    await this.repo.appendMessage({
      tenantId: args.tenant.id,
      conversationId: session.id,
      sender: "ASSISTANT",
      messageType: "STRUCTURED",
      content: message.key,
      structured: message.params ?? {},
    });

    const services = await this.tools.listServices({
      tenant: args.tenant,
      conversationId: session.id,
      locale: session.locale,
      timezone: session.timezone,
      collected: {},
      parameters: {},
      now: args.now,
    });

    return {
      token,
      expiresAt,
      response: {
        conversationId: session.id,
        state: session.machineState,
        status: "ACTIVE",
        message,
        ...(services.services === undefined ? {} : { services: services.services }),
        confirmation: null,
        bookingReference: null,
        turnsRemaining: this.options.maxTurns,
      },
    };
  }

  /** The conversation this token opens, or one uniform 404. */
  async resolve(args: {
    conversationId: string;
    token: string;
  }): Promise<{ session: ConversationSession; tenant: Tenant }> {
    const session = await this.repo.findByToken(args);
    if (!session) throw conversationNotFound();

    const tenant = await this.prisma.tenant.findUnique({ where: { id: session.tenantId } });
    if (!tenant) throw conversationNotFound();

    return { session, tenant };
  }

  /** Replay, for a page that was refreshed. Epic 7's own exit criterion. */
  async replay(args: { session: ConversationSession; tenant: Tenant }): Promise<
    ConversationTurnResponse & {
      messages: z.infer<typeof conversationMessageSchema>[];
      expiresAt: string;
    }
  > {
    const rows = await this.repo.messages({
      tenantId: args.tenant.id,
      conversationId: args.session.id,
    });

    const action = await this.repo.liveActionFor({
      tenantId: args.tenant.id,
      conversationId: args.session.id,
    });

    const collected = this.repo.collectedOf(args.session);

    return {
      conversationId: args.session.id,
      state: args.session.machineState,
      status: args.session.status,
      message: promptFor(args.session.machineState as CustomerBookingState, collected),
      ...(collected.lastSlots === undefined ? {} : { slots: collected.lastSlots }),
      confirmation:
        action === null
          ? null
          : {
              ...(action.previewJson as Omit<ConfirmationCard, "actionId" | "expiresAt">),
              actionId: action.id,
              expiresAt: action.expiresAt.toISOString(),
            },
      bookingReference: await this.referenceOf(args.session),
      turnsRemaining: Math.max(0, this.options.maxTurns - args.session.turnCount),
      expiresAt: args.session.expiresAt.toISOString(),
      messages: rows.map((row) => ({
        id: row.id,
        sender: row.sender,
        content: row.content,
        spoken: false,
        createdAt: row.createdAt.toISOString(),
      })),
    };
  }

  // --- A turn ---------------------------------------------------------------

  async message(args: {
    session: ConversationSession;
    tenant: Tenant;
    text: string;
    spoken: boolean;
    now: Date;
  }): Promise<ConversationTurnResponse> {
    const { session, tenant } = args;

    const turn = checkTurnAllowed({
      turnCount: session.turnCount,
      maxTurns: this.options.maxTurns,
      expiresAt: session.expiresAt,
      now: args.now,
    });

    if (!turn.allowed) {
      // The panel folds away and the form is still there (PRD §12.4).
      await this.settle(session, turn.reason === "CONVERSATION_EXPIRED" ? "EXPIRED" : "ACTIVE");
      return this.reply({
        session,
        tenant,
        collected: this.repo.collectedOf(session),
        message: refusalMessage(turn.reason),
      });
    }

    await this.repo.appendMessage({
      tenantId: tenant.id,
      conversationId: session.id,
      sender: "CUSTOMER",
      messageType: "TEXT",
      content: args.text,
    });

    const reservationId = await this.usage.reserveAiCall({
      tenantId: tenant.id,
      inputTokens: ESTIMATED_INPUT_TOKENS,
      outputTokens: this.options.maxOutputTokens,
      now: args.now,
    });

    const collected = this.repo.collectedOf(session);
    const state = session.machineState as CustomerBookingState;

    const history = await this.recentTurns(tenant.id, session.id);
    const catalogue = await this.tools.catalogueFor(tenant.id, session.locale);

    let interpretation;
    try {
      interpretation = await this.providers.interpreter.interpret({
        utterance: args.text,
        locale: session.locale,
        timezone: session.timezone,
        state,
        history,
        catalogue,
        businessContext: await this.assistant.knowledgeContext(tenant, session.locale),
      });
      await this.usage.reconcileAiCall({
        tenantId: tenant.id,
        reservationId,
        inputTokens: interpretation.usage.inputTokens ?? 0,
        outputTokens: interpretation.usage.outputTokens ?? 0,
        provider: interpretation.usage.provider,
        model: interpretation.usage.model,
        estimatedCostMinor: interpretation.usage.estimatedCostMinor,
        now: args.now,
      });
    } catch (error) {
      await this.usage.releaseAiReservation(tenant.id, reservationId);
      throw error;
    }

    const parsed = parseCommand(interpretation.envelope);

    if (!parsed.ok) {
      return this.reply({
        session,
        tenant,
        collected,
        message: refusalMessage("INTERPRETATION_FAILED"),
      });
    }

    const command = parsed.command;

    if (command.intent === "OUT_OF_SCOPE") {
      return this.reply({ session, tenant, collected, message: refusalMessage("OUT_OF_SCOPE") });
    }

    if (command.intent === "ANSWER_FAQ") {
      const answer =
        typeof command.parameters["answer"] === "string" ? command.parameters["answer"] : "";
      if (!answer) {
        return this.reply({ session, tenant, collected, message: refusalMessage("OUT_OF_SCOPE") });
      }
      return this.reply({
        session,
        tenant,
        collected,
        countTurn: true,
        message: { key: "conversation.answer", params: { answer }, ui: "NONE" },
      });
    }

    if (command.confidence < CONFIDENCE_FLOOR) {
      // One question is cheap. A confident guess is not.
      return this.reply({ session, tenant, collected, message: refusalMessage("LOW_CONFIDENCE") });
    }

    return this.run({ session, tenant, collected, command, now: args.now });
  }

  /**
   * Execute one validated command through the allowlist.
   *
   * An intent with no handler is refused exactly like an unknown one — which is
   * how a provider-side intent stays unreachable in a customer conversation
   * without a second check anybody has to remember.
   */
  private async run(args: {
    session: ConversationSession;
    tenant: Tenant;
    collected: StoredState;
    command: { intent: ConversationIntent; parameters: Record<string, unknown> };
    now: Date;
  }): Promise<ConversationTurnResponse> {
    const handler = this.tools.handlers()[args.command.intent];

    if (handler === undefined) {
      return this.reply({
        session: args.session,
        tenant: args.tenant,
        collected: args.collected,
        message: refusalMessage("OUT_OF_SCOPE"),
      });
    }

    const parameters = this.resolveOrdinal(args.command.parameters, args.collected);

    let outcome;
    try {
      outcome = await handler({
        tenant: args.tenant,
        conversationId: args.session.id,
        ...(args.session.bookingId === null ? {} : { bookingId: args.session.bookingId }),
        locale: args.session.locale,
        timezone: args.session.timezone,
        collected: args.collected,
        parameters,
        now: args.now,
      });
    } catch (error) {
      // The database refused, most often because somebody faster took the slot
      // (rule 14). That is a turn in the conversation, not a 500: the customer
      // is told and offered another time.
      const refusal = refusalFor(error);
      if (refusal === undefined) throw error;

      return this.reply({
        session: args.session,
        tenant: args.tenant,
        collected: forgetSlot(args.collected),
        message: refusalMessage(refusal),
      });
    }

    const collected: StoredState = { ...args.collected, ...outcome.collected };
    if (outcome.slots !== undefined) collected.lastSlots = outcome.slots;

    let confirmation: ConfirmationCard | null = null;

    if (outcome.prepare !== undefined) {
      const action = await this.repo.createPendingAction({
        tenantId: args.tenant.id,
        conversationId: args.session.id,
        toolName: outcome.prepare.tool,
        args: outcome.prepare.args,
        preview: { ...outcome.prepare.preview },
        expiresAt: new Date(args.now.getTime() + this.options.pendingActionTtlSeconds * 1_000),
      });

      confirmation = {
        ...outcome.prepare.preview,
        actionId: action.id,
        expiresAt: action.expiresAt.toISOString(),
      };
    }

    const nextState =
      outcome.prepare === undefined
        ? stateFor(collected, args.session.machineState as CustomerBookingState)
        : "AWAITING_CONFIRMATION";

    return this.reply({
      session: args.session,
      tenant: args.tenant,
      collected,
      state: nextState,
      message:
        outcome.refusal === undefined
          ? promptFor(nextState, collected)
          : refusalMessage(outcome.refusal),
      countTurn: true,
      confirmation,
      ...(outcome.services === undefined ? {} : { services: outcome.services }),
      ...(outcome.providers === undefined ? {} : { providers: outcome.providers }),
      ...(outcome.slots === undefined ? {} : { slots: outcome.slots }),
    });
  }

  // --- Voice ----------------------------------------------------------------

  /**
   * Audio in, transcript out, and nothing else.
   *
   * It does not interpret, does not call a tool and does not move the
   * conversation's state — PRD §10.1: the customer reviews what was heard, and
   * submitting it is a separate act, and the same act as typing. The practical
   * consequence is that a misheard utterance costs one transcription rather
   * than a wrong booking.
   */
  async transcribe(args: {
    session: ConversationSession;
    tenant: Tenant;
    audio: ValidatedAudio;
    now: Date;
  }): Promise<{ transcript: string; durationMs: number; detectedLanguage: string | null }> {
    const { session, tenant } = args;

    // Before the provider, never after (tech-impl §37).
    await this.usage.assertAllowed({
      tenantId: tenant.id,
      category: "VOICE_TRANSCRIPTION",
      requestedQuantity: args.audio.billableSeconds,
      now: args.now,
    });

    const result = await this.providers.transcription.transcribe({
      data: args.audio.data,
      durationMs: args.audio.durationMs,
      contentType: args.audio.contentType,
      filename: args.audio.filename,
      languageHint: session.locale,
    });

    await this.usage.record(
      {
        tenantId: tenant.id,
        category: "VOICE_TRANSCRIPTION",
        quantity: result.usage.audioSeconds ?? args.audio.billableSeconds,
        provider: result.usage.provider,
        model: result.usage.model,
        estimatedCostMinor: result.usage.estimatedCostMinor,
      },
      { now: args.now },
    );

    await this.repo.recordVoiceInteraction({
      tenantId: tenant.id,
      conversationId: session.id,
      audioDurationMs: result.audioDurationMs,
      provider: result.usage.provider,
      model: result.usage.model,
      transcript: result.transcript,
      detectedLanguage: result.detectedLanguage,
      estimatedCostMinor: result.usage.estimatedCostMinor,
    });

    // The buffer goes out of scope here and is never written anywhere
    // (docs/phase-8-push-to-talk-voice.md §4). There is no deletion job for a
    // thing that was never stored.
    return {
      transcript: result.transcript,
      durationMs: result.audioDurationMs,
      detectedLanguage: result.detectedLanguage ?? null,
    };
  }

  // --- Confirming -----------------------------------------------------------

  /**
   * Execute a named pending action. tech-impl §23.3.
   *
   * Four things are proved before anything runs — the action exists, it belongs
   * to this conversation, it has not expired, it has not already been used — and
   * the fourth is proved by *burning the row first*. Claiming before working is
   * the same rule the idempotency table follows, and for the same reason: between
   * a check and a write there is a window, and a customer double-tapping a
   * confirm button is reliably inside it.
   */
  async confirm(args: {
    session: ConversationSession;
    tenant: Tenant;
    actionId: string;
    idempotencyKey: string;
    audit: AuditContext;
    now: Date;
  }): Promise<ConversationTurnResponse> {
    const { session, tenant } = args;
    const collected = this.repo.collectedOf(session);

    const action = await this.repo.findPendingAction({
      tenantId: tenant.id,
      actionId: args.actionId,
    });

    if (action === null) throw conversationNotFound();

    const usable = checkPendingActionUsable({
      action: {
        id: action.id,
        sessionId: action.sessionId,
        toolName: action.toolName,
        status: action.status,
        expiresAt: action.expiresAt,
      },
      sessionId: session.id,
      now: args.now,
    });

    if (!usable.allowed) {
      return this.reply({
        session,
        tenant,
        collected,
        message: refusalMessage(
          usable.reason === "PENDING_ACTION_WRONG_SESSION"
            ? "PENDING_ACTION_ALREADY_USED"
            : usable.reason,
        ),
      });
    }

    const claimed = await this.repo.settleAction({
      tenantId: tenant.id,
      actionId: action.id,
      status: "CONFIRMED",
      now: args.now,
    });

    if (!claimed) {
      return this.reply({
        session,
        tenant,
        collected,
        message: refusalMessage("PENDING_ACTION_ALREADY_USED"),
      });
    }

    try {
      const { value } = await withIdempotency(
        this.prisma,
        {
          tenantId: tenant.id,
          operation: "public.conversations.confirm",
          key: args.idempotencyKey,
          requestBody: { actionId: action.id },
          successStatus: 200,
        },
        async () => {
          const values = action.argumentsJson as Record<string, unknown>;
          if (action.toolName === "confirmReschedule") {
            const bookingId = stringValue(values["bookingId"]);
            const booking = await this.bookings.confirmReschedule({
              tenantId: tenant.id,
              bookingId,
              input: { newStartAt: stringValue(values["newStartAt"]) },
              now: args.now,
              audit: args.audit,
            });
            return { bookingId: booking.id, reference: booking.reference };
          }
          if (action.toolName === "confirmCancellation") {
            const bookingId = stringValue(values["bookingId"]);
            const reason = typeof values["reason"] === "string" ? values["reason"] : undefined;
            const booking = await this.bookings.confirmCancellation({
              tenantId: tenant.id,
              bookingId,
              input: reason === undefined ? {} : { reason },
              now: args.now,
              audit: args.audit,
            });
            return { bookingId: booking.id, reference: booking.reference };
          }
          if (action.toolName !== "confirmBooking") throw conversationNotFound();
          const created = await this.bookings.confirmBooking({
            tenantId: tenant.id,
            input: action.argumentsJson as never,
            now: args.now,
            source: "CHAT",
            createdByUserId: null,
            audit: args.audit,
          });
          return { bookingId: created.booking.id, reference: created.booking.reference };
        },
      );

      await this.repo.update({
        tenantId: tenant.id,
        conversationId: session.id,
        data: { status: "COMPLETED", machineState: "COMPLETED", bookingId: value.bookingId },
      });

      return {
        conversationId: session.id,
        state: "COMPLETED",
        status: "COMPLETED",
        message: promptFor("COMPLETED", collected),
        confirmation: null,
        bookingReference: value.reference,
        turnsRemaining: Math.max(0, this.options.maxTurns - session.turnCount),
      };
    } catch (error) {
      const refusal = refusalFor(error);
      if (refusal === undefined) throw error;

      // The offer is spent either way — it described a slot that is now gone.
      // The conversation goes back to choosing a time rather than ending.
      return this.reply({
        session,
        tenant,
        collected: forgetSlot(collected),
        state: "SELECTING_SLOT",
        message: refusalMessage(refusal),
      });
    }
  }

  async cancelAction(args: {
    session: ConversationSession;
    tenant: Tenant;
    actionId: string;
    now: Date;
  }): Promise<ConversationTurnResponse> {
    await this.repo.settleAction({
      tenantId: args.tenant.id,
      actionId: args.actionId,
      status: "CANCELLED",
      now: args.now,
    });

    const collected = this.repo.collectedOf(args.session);

    return this.reply({
      session: args.session,
      tenant: args.tenant,
      collected,
      state: "SELECTING_SLOT",
      message: promptFor("SELECTING_SLOT", collected),
    });
  }

  // --- Support --------------------------------------------------------------

  /**
   * Persist the turn and shape the response.
   *
   * One place writes the assistant's message and the session's new state, so the
   * two cannot disagree — a reply that says "which time suits you" while the
   * stored state says `AWAITING_CONFIRMATION` is the bug this prevents.
   */
  private async reply(args: {
    session: ConversationSession;
    tenant: Tenant;
    collected: StoredState;
    message: AssistantMessage;
    state?: CustomerBookingState;
    countTurn?: boolean;
    confirmation?: ConfirmationCard | null;
    services?: z.infer<typeof conversationServiceSchema>[];
    providers?: z.infer<typeof conversationProviderSchema>[];
    slots?: z.infer<typeof conversationSlotSchema>[];
  }): Promise<ConversationTurnResponse> {
    const state = args.state ?? (args.session.machineState as CustomerBookingState);
    const now = new Date();

    await this.repo.appendMessage({
      tenantId: args.tenant.id,
      conversationId: args.session.id,
      sender: "ASSISTANT",
      messageType: "STRUCTURED",
      content: args.message.key,
      structured: args.message.params ?? {},
    });

    const updated = await this.repo.update({
      tenantId: args.tenant.id,
      conversationId: args.session.id,
      data: {
        machineState: state,
        stateJson: args.collected as Prisma.InputJsonValue,
        lastActivityAt: now,
        // Sliding, so a customer working through a booking is never cut off
        // mid-sentence and an abandoned tab still releases its hold on time.
        expiresAt: conversationExpiresAt(now, this.options.sessionTtlMinutes),
        ...(args.countTurn === true ? { turnCount: { increment: 1 } } : {}),
      },
    });

    return {
      conversationId: updated.id,
      state,
      status: updated.status,
      message: args.message,
      ...(args.services === undefined ? {} : { services: args.services }),
      ...(args.providers === undefined ? {} : { providers: args.providers }),
      ...(args.slots === undefined ? {} : { slots: args.slots }),
      confirmation: args.confirmation ?? null,
      bookingReference: await this.referenceOf(updated),
      turnsRemaining: Math.max(0, this.options.maxTurns - updated.turnCount),
    };
  }

  private async settle(session: ConversationSession, status: "EXPIRED" | "ACTIVE"): Promise<void> {
    if (status === "ACTIVE") return;

    await this.repo.update({
      tenantId: session.tenantId,
      conversationId: session.id,
      data: { status, machineState: status },
    });
  }

  private async referenceOf(session: ConversationSession): Promise<string | null> {
    if (session.bookingId === null) return null;

    const booking = await this.prisma.booking.findFirst({
      where: { id: session.bookingId, tenantId: session.tenantId },
      select: { reference: true },
    });

    return booking?.reference ?? null;
  }

  private async recentTurns(tenantId: string, conversationId: string): Promise<ConversationTurn[]> {
    const rows = await this.repo.messages({ tenantId, conversationId, limit: 20 });

    return rows
      .filter((row) => row.sender !== "SYSTEM")
      .map((row) => ({
        role: row.sender === "CUSTOMER" ? ("customer" as const) : ("assistant" as const),
        content: row.content,
      }));
  }

  /**
   * "The second one" against the list the customer was last shown.
   *
   * Resolved here rather than by the model, which has no reliable idea what was
   * on screen — and which, asked to remember, would eventually produce an
   * instant that was never offered.
   */
  private resolveOrdinal(
    parameters: Record<string, unknown>,
    collected: StoredState,
  ): Record<string, unknown> {
    const ordinal = parameters["slotOrdinal"];

    if (typeof ordinal !== "number" || collected.lastSlots === undefined) return parameters;

    const slot = collected.lastSlots[ordinal - 1];
    if (slot === undefined) return parameters;

    return { ...parameters, startAt: slot.startAt, providerId: slot.providerId };
  }
}

/**
 * Forget the slot, keep everything else.
 *
 * `exactOptionalPropertyTypes` is on, so an optional field is cleared by
 * removing the key rather than by assigning `undefined` — which is also the
 * honest representation: the conversation does not know a start time that is
 * `undefined`, it does not know one at all.
 */
function forgetSlot(collected: StoredState): StoredState {
  const { startAt: _startAt, holdId: _holdId, ...rest } = collected;
  return rest;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Which booking-engine failures are conversation turns rather than errors.
 *
 * Everything else propagates: a bug must not be reported to the customer as a
 * polite apology and swallowed.
 */
function refusalFor(error: unknown): RefusalKey | undefined {
  const code =
    typeof error === "object" && error !== null && "code" in error ? error.code : undefined;

  switch (code) {
    case "SLOT_NO_LONGER_AVAILABLE":
    case "SLOT_NOT_BOOKABLE":
      return "SLOT_NO_LONGER_AVAILABLE";
    case "HOLD_EXPIRED":
    case "HOLD_NOT_FOUND":
      return "HOLD_EXPIRED";
    default:
      return undefined;
  }
}
