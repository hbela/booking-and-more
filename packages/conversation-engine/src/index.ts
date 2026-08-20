/**
 * @bam/conversation-engine — the conversational booking flow's decisions, as
 * functions. tech-impl §22, §24 · docs/phase-7-chat-booking.md.
 *
 * Like @bam/booking-engine and @bam/availability-engine, this package imports no
 * Fastify, Prisma, Redis or HTTP client, and reaches no model (CLAUDE.md rule 8).
 * Its only dependency is @bam/availability-engine, for the timezone arithmetic
 * rule 13 says must happen in exactly one place.
 *
 * ## What is here and what is not
 *
 * Here: which state the conversation is in, what it still needs, whether a
 * pending action may be confirmed, what a spoken date expression means, and what
 * the assistant should say next.
 *
 * Not here: talking to a model (that is @bam/ai), executing a tool (that is the
 * API's `conversation.tools.ts`), and deciding who got the slot (that is
 * PostgreSQL — rule 14, and it does not change because the customer spoke).
 *
 * The command envelope lives in @bam/contracts rather than here, because it is
 * Zod and because three packages share it; see phase-7 §4.
 */

export {
  allowedTransitionsFrom,
  checkTransition,
  isTerminal,
  missingFieldsFor,
  stateFor,
} from "./machine.js";
export type { CollectedFields, CustomerBookingState, TransitionRefusal } from "./machine.js";

export {
  checkPendingActionUsable,
  effectivePendingActionStatus,
  pendingActionExpiresAt,
  readConfirmation,
} from "./pending.js";
export type {
  ConfirmableTool,
  ConfirmationReading,
  PendingActionRefusal,
  PendingActionStatus,
  PendingActionView,
} from "./pending.js";

export {
  DAYPARTS,
  DEFAULT_SEARCH_WINDOW_DAYS,
  instantFor,
  resolveDateExpression,
} from "./dates.js";
export type {
  DateRefusal,
  DateResolution,
  Daypart,
  MinuteOfDay,
  ResolvedDateRange,
} from "./dates.js";

export { REFUSAL_KEYS, greeting, promptFor, refusalMessage } from "./templates.js";
export type { AssistantMessage, RefusalKey, UiHint } from "./templates.js";

export { checkTurnAllowed, conversationExpiresAt } from "./turns.js";
export type { TurnRefusal } from "./turns.js";

export { ALLOWED, refuse } from "./types.js";
export type { Decision } from "./types.js";
