import type { DateOnly } from "./zone.js";

/**
 * The engine's input and output. tech-impl §13.1, §13.2.
 *
 * Everything arriving here is already resolved: the caller has loaded the
 * provider's working hours, the tenant's bookings, the holds and the calendar
 * busy times, and applied whatever tenant/provider/service inheritance decides
 * the notice and advance windows. The engine does no lookups and makes no
 * policy decisions about *where* a number came from — it only computes.
 */

/**
 * A recurring weekly period, in the provider's local wall-clock time.
 *
 * Stored as wall-clock on purpose (tech-impl §13.4): "Mondays 09:00–17:00" must
 * stay 09:00–17:00 on the Monday the clocks change, which a stored UTC offset
 * cannot express.
 */
export interface TimePeriod {
  /** ISO 8601 weekday: Monday = 1 … Sunday = 7. */
  weekday: number;
  /** `HH:mm`, local. */
  startTime: string;
  /**
   * `HH:mm`, local. `24:00` means midnight at the end of the day.
   *
   * An end at or before the start means the period runs past midnight into the
   * next day — "22:00–02:00" is a late shift, not an empty one.
   */
  endTime: string;
  /** Inclusive first date this period applies. Absent means "always has". */
  validFrom?: DateOnly | undefined;
  /** Inclusive last date this period applies. Absent means "still does". */
  validUntil?: DateOnly | undefined;
}

/** An absolute span. Both ends are ISO 8601 instants with an offset. */
export interface DateTimePeriod {
  startAt: string;
  endAt: string;
}

export interface AvailabilityQuery {
  /** Carried through to the caller's own bookkeeping; the engine does not read it. */
  providerId: string;

  serviceDurationMinutes: number;
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;

  /** Inclusive calendar range, interpreted in `timezone`. */
  dateFrom: DateOnly;
  dateTo: DateOnly;

  /** IANA zone the schedule is written in — the provider's, or the location's. */
  timezone: string;

  /**
   * Spacing of the offered start times, in minutes.
   *
   * Independent of the service duration: a 45-minute service offered on a
   * 15-minute grid gives 09:00, 09:15, 09:30 … not 09:00, 09:45.
   */
  slotIntervalMinutes: number;

  workingPeriods: TimePeriod[];
  /** One-off openings — a Saturday clinic. Added to the working periods. */
  additionalPeriods: DateTimePeriod[];
  /** One-off closures — holidays, sick leave. Subtracted. */
  unavailablePeriods: DateTimePeriod[];

  /** Confirmed bookings, already including their own buffers. */
  bookings: DateTimePeriod[];
  /** Unexpired holds. Treated exactly like bookings (tech-impl §11.3). */
  activeHolds: DateTimePeriod[];
  /** Busy times from a connected calendar (Epic 6). */
  externalBusyPeriods: DateTimePeriod[];

  /** How soon from `now` a booking may start. Zero means "up to the last second". */
  minimumNoticeMinutes: number;
  /** How far ahead bookings are accepted, in calendar days from today. */
  maximumAdvanceDays: number;

  /**
   * The moment the query is being answered, as an ISO instant.
   *
   * Not in tech-impl §13.1, and required: the engine may not call `Date.now()`
   * and still satisfy Epic 3's "slot calculations are deterministic". Passing
   * the clock in is what makes a daylight-saving test reproducible rather than
   * a thing that fails twice a year on CI.
   */
  now: string;
}

/** tech-impl §13.2. */
export interface AvailableSlot {
  /** When the appointment starts — what the customer is shown. */
  startAt: string;
  /** When it ends. `startAt` plus the service duration. */
  endAt: string;
  /** Start of the diary block, including the before-buffer. */
  occupiedFrom: string;
  /** End of the diary block, including the after-buffer. */
  occupiedUntil: string;
}

/** Half-open millisecond span `[start, end)`, used only inside the engine. */
export interface Interval {
  start: number;
  end: number;
}
