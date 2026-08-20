import { missingFieldsFor, type CollectedFields, type CustomerBookingState } from "./machine.js";

/**
 * Deterministic replies. tech-impl §20: *prefer deterministic template responses
 * for common booking steps.*
 *
 * Nothing here returns a sentence. A reply is a **message key and parameters**,
 * resolved by the next-intl catalogs the rest of the product's language already
 * lives in (tech-impl §38).
 *
 * Three things follow, and all three are the point:
 *
 *  - A Hungarian reply is a translation, not a prompt instruction that may or
 *    may not be honoured on any given call.
 *  - The assistant's wording cannot drift between deploys, and cannot be steered
 *    by anything a customer or a tenant's service name says.
 *  - The common path costs nothing. The model is reached only for the things
 *    only it can do: recognising intent, extracting entities, reading a date
 *    phrase, asking a clarifying question, and matching a spoken service name.
 */

/** What the panel should render alongside the message. */
export type UiHint =
  | "NONE"
  | "SERVICE_LIST"
  | "PROVIDER_LIST"
  | "SLOT_LIST"
  | "CUSTOMER_FORM"
  | "CONFIRMATION_CARD"
  | "BOOKING_SUMMARY";

export interface AssistantMessage {
  /** A key under the `conversation` namespace in `messages/{hu,en}.json`. */
  key: string;
  params?: Record<string, string | number>;
  ui: UiHint;
}

/**
 * What the assistant should say next, given only the state and what has been
 * collected.
 *
 * One question at a time (PRD §10.3). The order is the booking's own order, so
 * a customer who volunteers four things at once skips four questions rather than
 * being asked them anyway.
 */
export function promptFor(
  state: CustomerBookingState,
  collected: CollectedFields,
): AssistantMessage {
  switch (state) {
    case "START":
    case "SELECTING_SERVICE":
      return { key: "conversation.ask.service", ui: "SERVICE_LIST" };

    case "SELECTING_PROVIDER":
      return { key: "conversation.ask.provider", ui: "PROVIDER_LIST" };

    case "SELECTING_DATE":
      return { key: "conversation.ask.date", ui: "NONE" };

    case "SEARCHING_SLOTS":
      return { key: "conversation.searching", ui: "NONE" };

    case "SELECTING_SLOT":
      return { key: "conversation.ask.slot", ui: "SLOT_LIST" };

    case "HOLDING_SLOT":
      return { key: "conversation.holding", ui: "NONE" };

    case "COLLECTING_CUSTOMER_DETAILS": {
      const missing = missingFieldsFor(state, collected);

      // The name first, then a way to reach them. Asking for both at once is
      // what turns a conversation back into a form.
      if (missing.includes("fullName")) {
        return { key: "conversation.ask.name", ui: "CUSTOMER_FORM" };
      }

      return { key: "conversation.ask.contact", ui: "CUSTOMER_FORM" };
    }

    case "AWAITING_CONFIRMATION":
      return { key: "conversation.confirm.prompt", ui: "CONFIRMATION_CARD" };

    case "CONFIRMING_BOOKING":
      return { key: "conversation.confirming", ui: "NONE" };

    case "COMPLETED":
      return { key: "conversation.done", ui: "BOOKING_SUMMARY" };

    case "CANCELLED":
      return { key: "conversation.cancelled", ui: "NONE" };

    case "EXPIRED":
      return { key: "conversation.expired", ui: "NONE" };
  }
}

/**
 * Everything that can go wrong, as a key.
 *
 * Refusals are templates for the same reason replies are: a customer who has
 * just lost a slot to somebody faster should read a sentence somebody wrote and
 * a translator checked, not one a model composed while apologising.
 */
export const REFUSAL_KEYS = {
  UNRECOGNISED_DATE: "conversation.error.date",
  UNRECOGNISED_TIME: "conversation.error.time",
  OUT_OF_SCOPE: "conversation.error.outOfScope",
  LOW_CONFIDENCE: "conversation.error.unclear",
  NO_SLOTS: "conversation.error.noSlots",
  SLOT_NO_LONGER_AVAILABLE: "conversation.error.slotTaken",
  HOLD_EXPIRED: "conversation.error.holdExpired",
  PENDING_ACTION_EXPIRED: "conversation.error.offerExpired",
  PENDING_ACTION_ALREADY_USED: "conversation.error.alreadyConfirmed",
  TURN_LIMIT_REACHED: "conversation.error.turnLimit",
  CONVERSATION_EXPIRED: "conversation.error.sessionExpired",
  USAGE_QUOTA_EXCEEDED: "conversation.error.quota",
  INTERPRETATION_FAILED: "conversation.error.unclear",
  TRANSCRIPTION_FAILED: "conversation.error.transcription",
} as const;

export type RefusalKey = keyof typeof REFUSAL_KEYS;

export function refusalMessage(
  reason: RefusalKey,
  params?: Record<string, string | number>,
): AssistantMessage {
  return {
    key: REFUSAL_KEYS[reason],
    ...(params === undefined ? {} : { params }),
    // A refusal that removes the panel's affordances leaves the customer with
    // nowhere to go. Every one of these keeps whatever was on screen.
    ui: "NONE",
  };
}

/** The opening line, before the customer has said anything. */
export function greeting(tenantName: string): AssistantMessage {
  return { key: "conversation.greeting", params: { tenantName }, ui: "SERVICE_LIST" };
}
