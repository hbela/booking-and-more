import { z } from "zod";
import { idSchema, instantSchema } from "./common.js";

/**
 * A booking the schedule no longer covers.
 * docs/phase-3-4-schedule-conflicts.md §2.4, §2.6.
 *
 * One shape, two places: it is what `details.affectedBookings` carries on a
 * `SCHEDULE_CONFLICTS_BOOKINGS` refusal, and — minus the identifying fields the
 * caller already has — what each row of a booking list reports about itself.
 * Shared here rather than declared twice so the dialog and the badge cannot
 * describe the same state differently.
 *
 * Note this is a *staff-facing* shape and lives outside `/v1/public/*` by
 * construction (rule 12): a stranger is never told which of a clinic's
 * appointments are inconveniently placed.
 */

/**
 * Why an appointment is not covered. Mirrors `UncoveredReasons` in
 * @bam/availability-engine; the enum is restated rather than imported because
 * this package deliberately does not depend on that one. The two are held in
 * step by `schedule-conflicts.contract.test.ts` in `apps/api`, which is what
 * depends on both.
 */
export const uncoveredReasonSchema = z.enum(["OUTSIDE_WORKING_HOURS", "BLOCKED_BY_EXCEPTION"]);

export type UncoveredReasonCode = z.infer<typeof uncoveredReasonSchema>;

/**
 * Enough to recognise the appointment in a confirmation dialog without a second
 * request: who it is with, when, and the reference the customer would quote.
 *
 * No customer contact details. The dialog exists to answer "how many, and
 * when", and a list of names and phone numbers on a screen about working hours
 * is more personal data than the decision needs (rule 6).
 */
export const affectedBookingSchema = z.object({
  id: idSchema,
  reference: z.string(),
  startAt: instantSchema,
  endAt: instantSchema,
  providerId: idSchema,
  providerName: z.string(),
  serviceName: z.string(),
  /**
   * Null when the caller may manage this diary's *availability* but not read its
   * bookings — which became reachable with diary delegation
   * (docs/phase-3-4-diary-delegation.md §2.12) and could not happen before,
   * because nobody could hold one of those without the other.
   *
   * The dialog still works: the reference, the time, the service and the count
   * are what the decision needs. This field was always the part the comment
   * above argues hardest against, so the redaction costs nothing it was for.
   */
  customerName: z.string().nullable(),
  reason: uncoveredReasonSchema,
});

export type AffectedBooking = z.infer<typeof affectedBookingSchema>;

/**
 * What a booking row says about itself.
 *
 * Null is the ordinary answer and means "inside the schedule, or not worth
 * asking about" — a past or cancelled booking is never flagged (§2.3), so this
 * reads as "somebody should look at this" rather than as a historical fact.
 */
export const outsideScheduleSchema = uncoveredReasonSchema.nullable();
