import { z } from "zod";
import { currencySchema, idSchema, instantSchema, languageSchema, minorAmountSchema, timezoneSchema } from "@bam/contracts";

/**
 * What a stranger may send to the assistant and see back. CLAUDE.md rule 12.
 *
 * Declared separately from everything else for the same reason
 * `booking.schemas.ts` is: a conversation carries ids, previews and prices, and
 * the set of fields a customer sees must be a decision somebody made rather than
 * the residue of a `select`.
 *
 * Note what is *not* here: no `stateJson`, no `machineState`, no pending-action
 * arguments, no token hash, no model name, no cost. The panel needs to know what
 * to render and what to say; it does not need the conversation's internals, and
 * publishing them would tell a probe exactly which field to aim at.
 */

export const conversationChannelSchema = z.enum(["CHAT", "VOICE"]);

/** What the panel should render alongside the assistant's message. */
export const uiHintSchema = z.enum([
  "NONE",
  "SERVICE_LIST",
  "PROVIDER_LIST",
  "SLOT_LIST",
  "CUSTOMER_FORM",
  "CONFIRMATION_CARD",
  "BOOKING_SUMMARY",
]);

export const createConversationBodySchema = z.object({
  channel: conversationChannelSchema.default("CHAT"),
  /** The locale the page is being read in, not the tenant's default. */
  locale: languageSchema.default("hu"),
  /**
   * The customer's own zone, from `Intl.DateTimeFormat().resolvedOptions()`.
   * Every date expression is resolved against this: "tomorrow" means their
   * tomorrow, and the server's clock never enters into it.
   */
  timezone: timezoneSchema,
});

export const conversationParamsSchema = z.object({
  conversationId: idSchema,
});

export const actionParamsSchema = conversationParamsSchema.extend({
  actionId: idSchema,
});

/**
 * The session token, in a header rather than the path.
 *
 * A secret in a URL ends up in proxy logs, browser history and any `Referer` the
 * page happens to emit. It is also the only shape that works for the multipart
 * upload route without inventing a second convention.
 */
export const conversationTokenHeaderSchema = z.object({
  "x-conversation-token": z.string().min(20).max(200),
});

export const sendMessageBodySchema = z.object({
  text: z.string().trim().min(1).max(1_000),
  /** True when the text came from a transcript, for PRD §22.3's fallback rate. */
  spoken: z.boolean().default(false),
});

// ---------------------------------------------------------------------------
// What comes back
// ---------------------------------------------------------------------------

export const assistantMessageSchema = z.object({
  /** A key under the `conversation` namespace, never a sentence (tech-impl §20). */
  key: z.string(),
  params: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
  ui: uiHintSchema,
});

export const conversationMessageSchema = z.object({
  id: idSchema,
  sender: z.enum(["CUSTOMER", "ASSISTANT", "SYSTEM"]),
  /** The customer's own words, or the assistant's message key. */
  content: z.string(),
  spoken: z.boolean(),
  createdAt: instantSchema,
});

/** A slot, in the shape the panel already renders for the form path. */
export const conversationSlotSchema = z.object({
  providerId: idSchema,
  providerName: z.string(),
  startAt: instantSchema,
  endAt: instantSchema,
});

export const conversationServiceSchema = z.object({
  id: idSchema,
  name: z.string(),
  durationMinutes: z.number().int().positive(),
  priceMinor: minorAmountSchema.nullable(),
  currency: currencySchema.nullable(),
});

export const conversationProviderSchema = z.object({
  id: idSchema,
  displayName: z.string(),
});

/**
 * The confirmation card. PRD §9.14.
 *
 * `startAt` is an absolute instant and `dateLabel` is the absolute date already
 * formatted — never "tomorrow". A card that repeats the customer's own relative
 * phrase back at them confirms nothing, because it cannot be wrong.
 */
export const confirmationCardSchema = z.object({
  actionId: idSchema,
  tool: z.enum(["confirmBooking", "confirmReschedule", "confirmCancellation"]),
  serviceName: z.string(),
  providerName: z.string(),
  locationName: z.string().nullable(),
  startAt: instantSchema,
  endAt: instantSchema,
  priceMinor: minorAmountSchema.nullable(),
  currency: currencySchema.nullable(),
  customerName: z.string().nullable(),
  expiresAt: instantSchema,
});

/**
 * What every turn returns.
 *
 * One shape for creating a conversation, sending a message and confirming an
 * action, because the panel's job after each is identical: render the message,
 * render whatever `ui` names, and update what it knows.
 */
export const conversationTurnSchema = z.object({
  conversationId: idSchema,
  state: z.string(),
  status: z.enum(["ACTIVE", "COMPLETED", "CANCELLED", "EXPIRED"]),
  message: assistantMessageSchema,
  /** Populated only when `message.ui` asks for it. */
  services: z.array(conversationServiceSchema).optional(),
  providers: z.array(conversationProviderSchema).optional(),
  slots: z.array(conversationSlotSchema).optional(),
  confirmation: confirmationCardSchema.nullable(),
  /** Set once a booking exists. The management token is emailed, never here. */
  bookingReference: z.string().nullable(),
  turnsRemaining: z.number().int().min(0),
});

/** Creating one additionally hands over the token — once, and only here. */
export const conversationCreatedSchema = conversationTurnSchema.extend({
  sessionToken: z.string(),
  expiresAt: instantSchema,
});

/** Replaying one for a page that was refreshed. */
export const conversationStateSchema = conversationTurnSchema.extend({
  messages: z.array(conversationMessageSchema),
  expiresAt: instantSchema,
});

export type CreateConversationBody = z.infer<typeof createConversationBodySchema>;
export type SendMessageBody = z.infer<typeof sendMessageBodySchema>;
export type ConversationTurnResponse = z.infer<typeof conversationTurnSchema>;
export type AssistantMessagePayload = z.infer<typeof assistantMessageSchema>;
export type ConfirmationCard = z.infer<typeof confirmationCardSchema>;
