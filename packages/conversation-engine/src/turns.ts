import { ALLOWED, refuse, type Decision } from "./types.js";

/**
 * PRD §11's conversation-length controls.
 *
 * Both of these are ceilings on what one stranger who has not signed in can
 * spend. Neither is a quota — the quota is per tenant and per month
 * (`@bam/contracts`'s `PLAN_QUOTAS`); these bound a single conversation, which
 * is the unit an abusive client actually controls.
 */

export type TurnRefusal = "TURN_LIMIT_REACHED" | "CONVERSATION_EXPIRED";

export function checkTurnAllowed(args: {
  turnCount: number;
  maxTurns: number;
  expiresAt: string | number | Date;
  now: Date;
}): Decision<TurnRefusal> {
  const expiresAt =
    args.expiresAt instanceof Date ? args.expiresAt.getTime() : new Date(args.expiresAt).getTime();

  if (expiresAt <= args.now.getTime()) return refuse("CONVERSATION_EXPIRED");

  if (args.turnCount >= args.maxTurns) {
    return refuse("TURN_LIMIT_REACHED", { maxTurns: args.maxTurns });
  }

  return ALLOWED;
}

/**
 * A conversation's new deadline after a turn.
 *
 * Sliding rather than fixed: the window measures inactivity, so a customer
 * working through a booking is never cut off mid-sentence, and an abandoned tab
 * still releases its hold on schedule.
 */
export function conversationExpiresAt(now: Date, ttlMinutes: number): Date {
  return new Date(now.getTime() + ttlMinutes * 60_000);
}
