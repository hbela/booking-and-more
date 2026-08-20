import { z } from "zod";

/**
 * The structured command envelope. tech-impl §21.
 *
 * This lives in `@bam/contracts` rather than in `@bam/ai` or
 * `@bam/conversation-engine` because it is vocabulary three separate things
 * share: the AI package produces it, the API consumes it, the web renders from
 * it. Putting it in the AI package would make the API depend on an OpenAI client
 * to know what an intent is; putting it in the engine would put Zod inside a
 * package whose two siblings are deliberately dependency-free.
 *
 * docs/phase-7-chat-booking.md §4.
 */

/**
 * Every intent the model may emit.
 *
 * The provider-side intents (`GET_SCHEDULE`, `BLOCK_TIME`, …) are declared here
 * because tech-impl §21 declares them in one enum and splitting it would mean
 * two envelopes to keep in step. They are **not** in the customer tool allowlist
 * (`conversation.tools.ts`), which is what actually decides what can run — a
 * declared intent with no handler is refused like any other unknown one.
 */
export const conversationIntentSchema = z.enum([
  // Customer (Epics 7-8)
  "LIST_SERVICES",
  "GET_SERVICE_DETAILS",
  "SEARCH_SLOTS",
  "SELECT_SLOT",
  "CREATE_BOOKING",
  "GET_BOOKING",
  "RESCHEDULE_BOOKING",
  "CANCEL_BOOKING",
  "GET_LOCATION_DETAILS",
  "GET_PROVIDER_DETAILS",
  "ANSWER_FAQ",
  // Provider (a later slice — goal #1)
  "GET_SCHEDULE",
  "GET_FREE_PERIODS",
  "BLOCK_TIME",
  "OPEN_ADDITIONAL_TIME",
  // Neither: the customer said something the assistant does not do.
  "OUT_OF_SCOPE",
]);

export type ConversationIntent = z.infer<typeof conversationIntentSchema>;

/**
 * What the model returns, before any of it is trusted.
 *
 * `parameters` is deliberately `unknown`-valued: passing this schema means the
 * *shape of the answer* is right, not that the parameters are usable. Nothing
 * executes until `parseCommand` has put them through the intent's own schema
 * (tech-impl §21: "never execute parameters before validating against the
 * intent-specific schema").
 */
export const commandEnvelopeSchema = z.object({
  intent: conversationIntentSchema,
  confidence: z.number().min(0).max(1),
  parameters: z.record(z.string(), z.unknown()).default({}),
  missingFields: z.array(z.string()).default([]),
  requiresConfirmation: z.boolean(),
});

export type CommandEnvelope = z.infer<typeof commandEnvelopeSchema>;

// ---------------------------------------------------------------------------
// Per-intent parameters
//
// Dates and times arrive as *expressions*, not as instants. The model is asked
// what the customer said — "jövő kedden", "next Tuesday", "délután" — and the
// deterministic resolver in @bam/conversation-engine converts it against the
// conversation's timezone. A model asked for an ISO instant will be an hour
// wrong twice a year and confident both times (CLAUDE.md rule 13).
// ---------------------------------------------------------------------------

/** A service or provider the customer named in words rather than by id. */
const nameQuery = z.string().trim().min(1).max(120);

/** An id we gave them earlier in the conversation and they picked from a list. */
const referenceId = z.string().trim().min(1).max(64);

export const listServicesParametersSchema = z.object({
  query: nameQuery.optional(),
});

export const getServiceDetailsParametersSchema = z.object({
  serviceId: referenceId.optional(),
  serviceQuery: nameQuery.optional(),
});

export const searchSlotsParametersSchema = z.object({
  serviceId: referenceId.optional(),
  serviceQuery: nameQuery.optional(),
  providerId: referenceId.optional(),
  providerQuery: nameQuery.optional(),
  locationId: referenceId.optional(),
  /** "tomorrow", "next Tuesday", "jövő héten" — resolved by us, not by them. */
  dateExpression: z.string().trim().min(1).max(120).optional(),
  /** "afternoon", "around 5", "délután". */
  timeExpression: z.string().trim().min(1).max(120).optional(),
});

export const selectSlotParametersSchema = z.object({
  /** The index in the list the customer was just shown, 1-based as spoken. */
  slotOrdinal: z.number().int().positive().max(50).optional(),
  /** Or the exact instant, if they picked one from the grid rather than said it. */
  startAt: z.iso.datetime({ offset: true }).optional(),
  providerId: referenceId.optional(),
});

export const createBookingParametersSchema = z.object({
  fullName: z.string().trim().min(1).max(200).optional(),
  email: z.email().max(320).optional(),
  phone: z.string().trim().min(3).max(40).optional(),
  notes: z.string().trim().max(1_000).optional(),
});

export const getBookingParametersSchema = z.object({
  reference: z.string().trim().min(1).max(40).optional(),
});

export const rescheduleBookingParametersSchema = z.object({
  dateExpression: z.string().trim().min(1).max(120).optional(),
  timeExpression: z.string().trim().min(1).max(120).optional(),
  startAt: z.iso.datetime({ offset: true }).optional(),
});

export const cancelBookingParametersSchema = z.object({
  reason: z.string().trim().max(500).optional(),
});

export const detailsParametersSchema = z.object({
  locationId: referenceId.optional(),
  providerId: referenceId.optional(),
  query: nameQuery.optional(),
});

/** No parameters, and none accepted. */
export const emptyParametersSchema = z.object({});
export const answerFaqParametersSchema = z.object({
  answer: z.string().trim().min(1).max(4_000),
});

/**
 * The schema each intent's parameters must satisfy.
 *
 * A provider-side intent maps to `emptyParametersSchema` rather than to a real
 * one: it cannot run in a customer conversation, so validating its arguments
 * would only make an unreachable path look reachable.
 */
export const INTENT_PARAMETERS = {
  LIST_SERVICES: listServicesParametersSchema,
  GET_SERVICE_DETAILS: getServiceDetailsParametersSchema,
  SEARCH_SLOTS: searchSlotsParametersSchema,
  SELECT_SLOT: selectSlotParametersSchema,
  CREATE_BOOKING: createBookingParametersSchema,
  GET_BOOKING: getBookingParametersSchema,
  RESCHEDULE_BOOKING: rescheduleBookingParametersSchema,
  CANCEL_BOOKING: cancelBookingParametersSchema,
  GET_LOCATION_DETAILS: detailsParametersSchema,
  GET_PROVIDER_DETAILS: detailsParametersSchema,
  ANSWER_FAQ: answerFaqParametersSchema,
  GET_SCHEDULE: emptyParametersSchema,
  GET_FREE_PERIODS: emptyParametersSchema,
  BLOCK_TIME: emptyParametersSchema,
  OPEN_ADDITIONAL_TIME: emptyParametersSchema,
  OUT_OF_SCOPE: emptyParametersSchema,
} as const satisfies Record<ConversationIntent, z.ZodType>;

export type IntentParameters<I extends ConversationIntent> = z.infer<
  (typeof INTENT_PARAMETERS)[I]
>;

/** A command that has been through both validations and may be acted on. */
export interface ParsedCommand {
  intent: ConversationIntent;
  confidence: number;
  parameters: Record<string, unknown>;
  missingFields: string[];
  requiresConfirmation: boolean;
}

export type ParseCommandResult =
  | { ok: true; command: ParsedCommand }
  | { ok: false; reason: "MALFORMED_ENVELOPE" | "INVALID_PARAMETERS"; issues: string[] };

/**
 * The two validations, in order, as one call.
 *
 * Returns a result rather than throwing, because a model producing nonsense is
 * an ordinary Tuesday and not an exception: the caller asks a clarifying
 * question and the conversation carries on from where it was.
 *
 * **Unknown parameter keys are stripped, not rejected.** A model that adds a
 * helpful `"notes"` to a slot search should not fail the turn — but the stripped
 * object is what reaches the tool, so the extra key cannot reach a query either.
 */
export function parseCommand(input: unknown): ParseCommandResult {
  const envelope = commandEnvelopeSchema.safeParse(input);

  if (!envelope.success) {
    return {
      ok: false,
      reason: "MALFORMED_ENVELOPE",
      issues: envelope.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
    };
  }

  const parameters = INTENT_PARAMETERS[envelope.data.intent].safeParse(envelope.data.parameters);

  if (!parameters.success) {
    return {
      ok: false,
      reason: "INVALID_PARAMETERS",
      issues: parameters.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
    };
  }

  return {
    ok: true,
    command: {
      intent: envelope.data.intent,
      confidence: envelope.data.confidence,
      parameters: parameters.data,
      missingFields: envelope.data.missingFields,
      requiresConfirmation: envelope.data.requiresConfirmation,
    },
  };
}
