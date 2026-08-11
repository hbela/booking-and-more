import { ALLOWED, refuse, type Decision } from "./types.js";

/**
 * The customer booking conversation as an explicit state machine. tech-impl §22.
 *
 * The spec's reason for an explicit machine rather than message history is
 * PRD §9.15: the language model must not be the sole storage location for
 * booking state. The practical reason is narrower and sharper — a model asked to
 * remember a `serviceId` across six turns will eventually produce one that looks
 * right and is not, and the first thing that notices is a foreign key.
 *
 * So the machine holds the ids and the model holds nothing.
 */

export type CustomerBookingState =
  | "START"
  | "SELECTING_SERVICE"
  | "SELECTING_PROVIDER"
  | "SELECTING_DATE"
  | "SEARCHING_SLOTS"
  | "SELECTING_SLOT"
  | "HOLDING_SLOT"
  | "COLLECTING_CUSTOMER_DETAILS"
  | "AWAITING_CONFIRMATION"
  | "CONFIRMING_BOOKING"
  | "COMPLETED"
  | "CANCELLED"
  | "EXPIRED";

/**
 * What the conversation has collected so far. This is the `state_json` column's
 * shape — the engine defines it, the database stores it opaquely.
 *
 * Ids only. Names and prices are read back from the catalogue when they are
 * needed, so a service renamed mid-conversation shows its new name rather than
 * the one that happened to be cached, and the snapshot that matters is the one
 * `buildBookingSnapshot` takes at confirmation (rule 15).
 */
export interface CollectedFields {
  serviceId?: string;
  providerId?: string;
  locationId?: string;
  /** Inclusive `YYYY-MM-DD` range the customer asked about. */
  dateFrom?: string;
  dateTo?: string;
  /** Minutes since midnight, in the conversation's zone. */
  timeFrom?: number;
  timeTo?: number;
  /** The slot the customer picked, as an ISO instant. */
  startAt?: string;
  holdId?: string;
  fullName?: string;
  email?: string;
  phone?: string;
  notes?: string;
  /** Supplied mid-conversation when they want to change an existing booking. */
  managementToken?: string;
}

/** The fields each state needs before it can be left. */
const REQUIRED_BY_STATE: Partial<Record<CustomerBookingState, (keyof CollectedFields)[]>> = {
  SELECTING_SERVICE: ["serviceId"],
  SELECTING_DATE: ["dateFrom"],
  SELECTING_SLOT: ["startAt", "providerId"],
  HOLDING_SLOT: ["holdId"],
  COLLECTING_CUSTOMER_DETAILS: ["fullName"],
};

const TERMINAL: ReadonlySet<CustomerBookingState> = new Set<CustomerBookingState>([
  "COMPLETED",
  "CANCELLED",
  "EXPIRED",
]);

export function isTerminal(state: CustomerBookingState): boolean {
  return TERMINAL.has(state);
}

/**
 * What is still missing before the state can be left.
 *
 * `COLLECTING_CUSTOMER_DETAILS` deliberately asks only for a name here; the
 * "email **or** phone" rule belongs to `publicCustomerInputSchema`, which is
 * where the form path enforces it too. Restating it would give the product two
 * definitions of a reachable customer.
 */
export function missingFieldsFor(
  state: CustomerBookingState,
  collected: CollectedFields,
): (keyof CollectedFields)[] {
  const required = REQUIRED_BY_STATE[state] ?? [];

  const missing = required.filter((field) => collected[field] === undefined);

  if (state === "COLLECTING_CUSTOMER_DETAILS" && collected.email === undefined && collected.phone === undefined) {
    missing.push("email");
  }

  return missing;
}

/**
 * The state the conversation should be in, given what it knows.
 *
 * Derived rather than stepped. A machine that only moves forward one edge at a
 * time has to enumerate every shortcut a customer can take — and the first
 * sentence of a real conversation is usually "can I book a cleaning with Anna
 * next Tuesday afternoon", which fills four fields at once. Deriving means that
 * sentence lands in `SEARCHING_SLOTS` without a special case, and that a
 * customer who changes their mind about the service falls back to
 * `SELECTING_SLOT` by having their `startAt` cleared rather than by an edge
 * somebody had to remember to draw.
 *
 * Terminal states are never derived out of: a completed booking stays completed.
 */
export function stateFor(
  collected: CollectedFields,
  current: CustomerBookingState = "START",
): CustomerBookingState {
  if (isTerminal(current)) return current;
  if (current === "AWAITING_CONFIRMATION" || current === "CONFIRMING_BOOKING") return current;

  if (collected.serviceId === undefined) return "SELECTING_SERVICE";
  if (collected.dateFrom === undefined) return "SELECTING_DATE";
  if (collected.startAt === undefined) return "SELECTING_SLOT";
  if (collected.holdId === undefined) return "HOLDING_SLOT";

  if (missingFieldsFor("COLLECTING_CUSTOMER_DETAILS", collected).length > 0) {
    return "COLLECTING_CUSTOMER_DETAILS";
  }

  return "AWAITING_CONFIRMATION";
}

export type TransitionRefusal =
  | "CONVERSATION_FINISHED"
  /** The state exists but nothing gets there from here. */
  | "NOT_A_TRANSITION";

/** Which states may follow which. Terminal states have no successors. */
const TRANSITIONS: Record<CustomerBookingState, CustomerBookingState[]> = {
  START: ["SELECTING_SERVICE", "SELECTING_DATE", "SEARCHING_SLOTS", "CANCELLED", "EXPIRED"],
  SELECTING_SERVICE: ["SELECTING_PROVIDER", "SELECTING_DATE", "SEARCHING_SLOTS", "CANCELLED", "EXPIRED"],
  SELECTING_PROVIDER: ["SELECTING_DATE", "SEARCHING_SLOTS", "SELECTING_SERVICE", "CANCELLED", "EXPIRED"],
  SELECTING_DATE: ["SEARCHING_SLOTS", "SELECTING_SERVICE", "SELECTING_PROVIDER", "CANCELLED", "EXPIRED"],
  SEARCHING_SLOTS: ["SELECTING_SLOT", "SELECTING_DATE", "SELECTING_SERVICE", "CANCELLED", "EXPIRED"],
  SELECTING_SLOT: ["HOLDING_SLOT", "SEARCHING_SLOTS", "SELECTING_DATE", "CANCELLED", "EXPIRED"],
  HOLDING_SLOT: ["COLLECTING_CUSTOMER_DETAILS", "SELECTING_SLOT", "CANCELLED", "EXPIRED"],
  COLLECTING_CUSTOMER_DETAILS: ["AWAITING_CONFIRMATION", "SELECTING_SLOT", "CANCELLED", "EXPIRED"],
  AWAITING_CONFIRMATION: [
    "CONFIRMING_BOOKING",
    "COLLECTING_CUSTOMER_DETAILS",
    "SELECTING_SLOT",
    "CANCELLED",
    "EXPIRED",
  ],
  CONFIRMING_BOOKING: ["COMPLETED", "SELECTING_SLOT", "CANCELLED", "EXPIRED"],
  COMPLETED: [],
  CANCELLED: [],
  EXPIRED: [],
};

/**
 * May the conversation move from here to there?
 *
 * The one transition worth naming: `CONFIRMING_BOOKING → SELECTING_SLOT` is
 * legal, because the slot can be taken between the preview and the confirm. That
 * is `SLOT_NO_LONGER_AVAILABLE` arriving from the database (rule 14), and the
 * conversation's job is to offer another time rather than to end.
 */
export function checkTransition(
  from: CustomerBookingState,
  to: CustomerBookingState,
): Decision<TransitionRefusal> {
  if (isTerminal(from)) return refuse("CONVERSATION_FINISHED", { from });
  if (!TRANSITIONS[from].includes(to)) return refuse("NOT_A_TRANSITION", { from, to });

  return ALLOWED;
}

export function allowedTransitionsFrom(state: CustomerBookingState): CustomerBookingState[] {
  return [...TRANSITIONS[state]];
}
