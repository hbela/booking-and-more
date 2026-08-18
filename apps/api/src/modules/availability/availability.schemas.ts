import { z } from "zod";
import {
  dateOnlySchema,
  idSchema,
  instantSchema,
  timeOnlySchema,
  timezoneSchema,
  weekdaySchema,
} from "@bam/contracts";

/**
 * Working hours are wall-clock, exceptions are instants.
 *
 * That asymmetry is the whole model (tech-impl §13.4): "Mondays from 09:00" is
 * a rule that survives a clock change, "closed on the 24th from 12:00" is an
 * event that happened at a moment. Conflating them is how a schedule ends up an
 * hour wrong for half the year.
 */

/** `HH:mm`, plus `24:00` for a period that runs to midnight. */
const endTimeSchema = z.union([timeOnlySchema, z.literal("24:00")]);

export const workingHoursEntrySchema = z.object({
  weekday: weekdaySchema,
  startTime: timeOnlySchema,
  endTime: endTimeSchema,
  /** Null means "wherever this provider works". */
  locationId: idSchema.nullable().optional(),
  validFrom: dateOnlySchema.nullable().optional(),
  validUntil: dateOnlySchema.nullable().optional(),
  active: z.boolean().default(true),
});

/**
 * A whole-week replacement, like the Epic 2 assignment endpoints.
 *
 * The dashboard edits a week as one grid, so "here is the complete week" is
 * what the user actually expressed. It is idempotent under a double submit, and
 * a dropped connection mid-edit cannot leave a provider with Tuesday saved and
 * Wednesday not.
 */
export const setWorkingHoursBodySchema = z.object({
  workingHours: z.array(workingHoursEntrySchema).max(100),
  /**
   * "Yes, I know this strands existing bookings — do it anyway."
   *
   * Absent or false, a save that would leave confirmed appointments outside the
   * new schedule is refused once with `SCHEDULE_CONFLICTS_BOOKINGS` and the list
   * of them (docs/phase-3-4-schedule-conflicts.md §2.4). Not a permission and
   * not a force flag: the change is the clinic's to make, and this only makes
   * them make it knowingly.
   */
  acknowledgeAffectedBookings: z.boolean().default(false),
  /**
   * The `fingerprint` the `GET` returned — proof this body was built from a
   * current read of this same week (docs/phase-3-4-diary-delegation.md §2.14).
   *
   * **Genuinely required**, and optional *here* for the reason
   * `idempotencyHeaderSchema` is: Fastify validates the body before the
   * preHandler runs, so marking it required would answer a caller with no
   * permission on this diary with a 422 about a missing field instead of a 403.
   * `requireScheduleFingerprint` refuses it in the handler, after authorization,
   * with `SCHEDULE_FINGERPRINT_REQUIRED` — a distinct code because "you did not
   * read before writing" is a different fix from "your body is wrong".
   */
  expectedFingerprint: z
    .string()
    .min(1)
    .max(64)
    .optional()
    .describe("Required. The `fingerprint` from this provider's working-hours GET."),
});

export const workingHoursResponseSchema = z.object({
  id: idSchema,
  providerId: idSchema,
  locationId: z.string().nullable(),
  weekday: z.number().int(),
  startTime: z.string(),
  endTime: z.string(),
  validFrom: z.string().nullable(),
  validUntil: z.string().nullable(),
  active: z.boolean(),
});

/**
 * Who last replaced this week, and when.
 *
 * Exists because diary delegation made a second editor the *expected*
 * configuration rather than a rarity: a provider and their assistant hold equal
 * write power on one diary (docs/phase-3-4-diary-delegation.md §2.3), and
 * `replaceWorkingHours` is a delete-then-insert with no version check, so the
 * later of two saves silently reverts the earlier one. This does not prevent
 * that — optimistic concurrency is the fix and is not built — but it makes the
 * other editor **visible**, which is the difference between a conflict somebody
 * notices and one nobody ever finds out about.
 *
 * Read from the audit log rather than from a column on `working_hours`: the row
 * is already written on every save, the whole-week replace destroys any column
 * we might have put there, and a second source of the same fact would be a
 * second thing to keep true.
 *
 * **Eventually consistent, deliberately.** `request.audit()` is fire-and-forget
 * (`audit.plugin.ts` — an audit failure must not fail the user's write), so this
 * field can lag a save by a moment. The lag only ever affects attributing *your
 * own* save immediately after making it, which is the one case the reader
 * already knows the answer to; the other editor's change is what this is for,
 * and it arrives by a later fetch either way. Reversing the trade — awaiting the
 * audit write — would make a provenance line able to fail a schedule save.
 */
export const scheduleLastChangeSchema = z.object({
  at: z.iso.datetime({ offset: true }),
  /**
   * Null when the audit row names no user — a system actor, or an account
   * deleted since. The time is still worth showing on its own.
   */
  by: z
    .object({
      userId: idSchema,
      name: z.string(),
    })
    .nullable(),
});

export const exceptionTypeSchema = z.enum(["UNAVAILABLE", "ADDITIONAL_AVAILABILITY"]);
export const exceptionSourceSchema = z.enum(["DASHBOARD", "VOICE", "CHAT", "CALENDAR", "API"]);

export const createExceptionBodySchema = z
  .object({
    type: exceptionTypeSchema,
    startAt: instantSchema,
    endAt: instantSchema,
    /** Narrow it to one site, or leave null for everything the provider does. */
    locationId: idSchema.nullable().optional(),
    serviceId: idSchema.nullable().optional(),
    /** Staff-facing only. Never shown to a customer. */
    reason: z.string().max(500).nullable().optional(),
    /** See `setWorkingHoursBodySchema`. Only ever consulted for `UNAVAILABLE`. */
    acknowledgeAffectedBookings: z.boolean().default(false),
  })
  .refine((body) => Date.parse(body.endAt) > Date.parse(body.startAt), {
    message: "endAt must be after startAt.",
    path: ["endAt"],
  });

export const updateExceptionBodySchema = z
  .object({
    type: exceptionTypeSchema,
    startAt: instantSchema,
    endAt: instantSchema,
    locationId: idSchema.nullable(),
    serviceId: idSchema.nullable(),
    reason: z.string().max(500).nullable(),
    /**
     * See `setWorkingHoursBodySchema`. Optional here like everything else in a
     * PATCH, and read as false when absent — an acknowledgement has to be given,
     * never inferred.
     */
    acknowledgeAffectedBookings: z.boolean(),
  })
  .partial();
// The start-before-end rule is not re-checked here: a PATCH that moves only one
// end has to be compared against the stored other end, which a schema cannot
// see. The service does it, and the database has a CHECK constraint underneath.

export const exceptionResponseSchema = z.object({
  id: idSchema,
  providerId: idSchema,
  locationId: z.string().nullable(),
  serviceId: z.string().nullable(),
  type: exceptionTypeSchema,
  startAt: instantSchema,
  endAt: instantSchema,
  reason: z.string().nullable(),
  source: exceptionSourceSchema,
  createdAt: instantSchema,
});

export const listExceptionsQuerySchema = z.object({
  /** Defaults to a window around today rather than the whole table. */
  from: dateOnlySchema.optional(),
  to: dateOnlySchema.optional(),
});

// --- Slot search -----------------------------------------------------------

/**
 * tech-impl §16's slot search, and the staff-side preview that shares it.
 *
 * `timezone` is the zone the *caller* wants answers in. It does not change
 * which slots exist — those come from the provider's own zone — only how the
 * range is interpreted and displayed.
 */
export const slotSearchBodySchema = z
  .object({
    serviceId: idSchema,
    providerId: idSchema.optional(),
    locationId: idSchema.optional(),
    dateFrom: dateOnlySchema,
    dateTo: dateOnlySchema,
    timezone: timezoneSchema.optional(),
  })
  .refine((body) => body.dateTo >= body.dateFrom, {
    message: "dateTo must not be before dateFrom.",
    path: ["dateTo"],
  })
  .refine(
    (body) => {
      // A year of slots is not a search, it is an export. Bounded here because
      // the engine will happily compute it and the response would be enormous.
      const days =
        (Date.parse(`${body.dateTo}T00:00:00Z`) - Date.parse(`${body.dateFrom}T00:00:00Z`)) /
        86_400_000;
      return days <= 62;
    },
    { message: "Search at most 62 days at a time.", path: ["dateTo"] },
  );

export const slotResponseSchema = z.object({
  providerId: idSchema,
  startAt: instantSchema,
  endAt: instantSchema,
  /** Includes buffers — the diary block, not the appointment. */
  occupiedFrom: instantSchema,
  occupiedUntil: instantSchema,
});

export type SetWorkingHoursBody = z.infer<typeof setWorkingHoursBodySchema>;
export type WorkingHoursEntry = z.infer<typeof workingHoursEntrySchema>;
export type CreateExceptionBody = z.infer<typeof createExceptionBodySchema>;
export type UpdateExceptionBody = z.infer<typeof updateExceptionBodySchema>;
export type SlotSearchBody = z.infer<typeof slotSearchBodySchema>;
