/**
 * Shared vocabulary. Kept identical in shape to @bam/booking-engine's, so a
 * caller handling refusals from both does not need two idioms.
 */

export type Decision<TReason extends string> =
  | { allowed: true }
  | { allowed: false; reason: TReason; detail?: Record<string, unknown> };

export const ALLOWED: Decision<never> = { allowed: true };

export function refuse<TReason extends string>(
  reason: TReason,
  detail?: Record<string, unknown>,
): Decision<TReason> {
  return detail === undefined ? { allowed: false, reason } : { allowed: false, reason, detail };
}
