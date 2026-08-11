import { ALLOWED, refuse, type Decision } from "./types.js";

/**
 * Pending actions. tech-impl §22.1.
 *
 * The rule this file exists to make true: **a generic "yes" must never confirm
 * an unknown or expired action.** Everything here is the four questions the
 * confirm path has to answer before it executes anything.
 *
 * docs/phase-7-chat-booking.md §5 records why the action is a row rather than a
 * field on the session's state.
 */

/** The confirm tools. Read tools execute immediately and have nothing to confirm. */
export type ConfirmableTool =
  | "confirmBooking"
  | "confirmReschedule"
  | "confirmCancellation";

export type PendingActionStatus = "PENDING" | "CONFIRMED" | "CANCELLED" | "EXPIRED";

export interface PendingActionView {
  id: string;
  sessionId: string;
  toolName: string;
  status: PendingActionStatus;
  /** ISO instant or epoch milliseconds — whatever the caller has to hand. */
  expiresAt: string | number | Date;
}

export type PendingActionRefusal =
  | "PENDING_ACTION_EXPIRED"
  | "PENDING_ACTION_ALREADY_USED"
  | "PENDING_ACTION_WRONG_SESSION";

function instantOf(value: string | number | Date): number {
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

/**
 * When an action stops being confirmable.
 *
 * Deliberately shorter than the hold it accompanies. An action that outlived its
 * reservation would present the customer a card they can still press, whose
 * pressing then fails on a hold that expired — a worse experience than being
 * told the offer lapsed, and one that costs a confirmation attempt to discover.
 */
export function pendingActionExpiresAt(now: Date, ttlSeconds: number): Date {
  return new Date(now.getTime() + ttlSeconds * 1_000);
}

/**
 * The status an action *actually* has, which is not always the one stored.
 *
 * A row goes stale between the sweep's passes. Reading the clock rather than the
 * column means an expired action is refused on the request that finds it, not on
 * the one that happens to arrive after the sweeper woke up. The same reasoning
 * as `effectiveHoldStatus` in @bam/booking-engine.
 */
export function effectivePendingActionStatus(
  action: Pick<PendingActionView, "status" | "expiresAt">,
  now: Date,
): PendingActionStatus {
  if (action.status !== "PENDING") return action.status;

  return instantOf(action.expiresAt) <= now.getTime() ? "EXPIRED" : "PENDING";
}

/**
 * Is this action confirmable, by this session, now?
 *
 * The session check is not decoration. The action id is a cuid a stranger cannot
 * guess, but "cannot guess" is not an authorization model — a customer who
 * shares a link, or a conversation resumed with a stolen token, must not be able
 * to confirm an action belonging to a different conversation.
 */
export function checkPendingActionUsable(args: {
  action: PendingActionView;
  sessionId: string;
  now: Date;
}): Decision<PendingActionRefusal> {
  if (args.action.sessionId !== args.sessionId) {
    return refuse("PENDING_ACTION_WRONG_SESSION");
  }

  const status = effectivePendingActionStatus(args.action, args.now);

  if (status === "EXPIRED") return refuse("PENDING_ACTION_EXPIRED");
  if (status !== "PENDING") return refuse("PENDING_ACTION_ALREADY_USED", { status });

  return ALLOWED;
}

/**
 * Did the customer actually agree?
 *
 * PRD §9.14 lists what counts, and the important half is what does not: "maybe",
 * "I think so", "sure, but can you…" are not confirmations. Anything not
 * recognised falls through to the model, which asks again — the cost of an extra
 * question is a question; the cost of a false positive is a booking somebody did
 * not make.
 *
 * This is a *convenience*, not the mechanism. Confirmation is the confirm route
 * being called with a named action id; this only decides whether a typed or
 * spoken sentence should trigger that call.
 */
const AFFIRMATIONS: ReadonlySet<string> = new Set([
  // English
  "yes",
  "yes please",
  "confirm",
  "confirmed",
  "go ahead",
  "book it",
  "that works",
  "ok",
  "okay",
  // Hungarian
  "igen",
  "igen kérem",
  "rendben",
  "megerősítem",
  "foglalom",
  "lefoglalom",
  "jó",
  "jó lesz",
]);

const NEGATIONS: ReadonlySet<string> = new Set([
  "no",
  "no thanks",
  "cancel",
  "stop",
  "nem",
  "mégsem",
  "mégse",
  "inkább nem",
]);

export type ConfirmationReading = "AFFIRMED" | "DECLINED" | "UNCLEAR";

export function readConfirmation(utterance: string): ConfirmationReading {
  // Trim before stripping punctuation as well as after: a transcript arrives
  // with trailing whitespace often enough that an anchored `$` would otherwise
  // never match the full stop the speech model added.
  const normalized = utterance
    .toLocaleLowerCase("hu")
    .trim()
    .replace(/[.!?,;:]+$/u, "")
    .trim();

  if (AFFIRMATIONS.has(normalized)) return "AFFIRMED";
  if (NEGATIONS.has(normalized)) return "DECLINED";

  return "UNCLEAR";
}
