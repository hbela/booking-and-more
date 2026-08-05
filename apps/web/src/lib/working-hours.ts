import type { WorkingHoursRow } from "./api-client";

/**
 * The weekly schedule, between the API's flat row list and the editor's grid.
 *
 * ## Why every field round-trips
 *
 * `PUT /v1/providers/:id/working-hours` replaces the whole week. The first
 * editor sent `{ weekday, startTime, endTime }` and nothing else, which meant
 * `locationId`, `validFrom`, `validUntil` and `active` were dropped on every
 * save — a multi-location tenant could not express "Mondays at the annexe" at
 * all, and any such row created through the API was destroyed the next time
 * anybody touched the dashboard.
 *
 * ## What is deliberately *not* converted
 *
 * These are wall-clock times, not instants (CLAUDE.md rule 13, tech-impl §13.4).
 * "Mondays 09:00–17:00" has to stay 09:00–17:00 on the Monday the clocks change,
 * so nothing here applies an offset, and nothing here should ever start to. The
 * timezone-aware half of the availability screen is exceptions, which name
 * actual moments — see `./exception-time`.
 */

/** ISO 8601 weekdays, Monday first. */
export const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const;

/**
 * A period that runs to the end of the day.
 *
 * The API accepts it and the database's CHECK constraint allows it, but
 * `<input type="time">` cannot hold it — HTML's valid time string stops at
 * 23:59. So the editor offers a checkbox instead, and this constant is the value
 * both sides agree on.
 */
export const END_OF_DAY = "24:00";

export interface WorkingPeriod {
  startTime: string;
  /** `HH:mm`, or {@link END_OF_DAY}. */
  endTime: string;
  /** NULL means "wherever this provider works". */
  locationId: string | null;
  /** `YYYY-MM-DD`, never a Date — see {@link buildWorkingHoursBody}. */
  validFrom: string | null;
  validUntil: string | null;
  active: boolean;
}

export type WorkingWeek = Record<number, WorkingPeriod[]>;

export interface WorkingHoursInput extends WorkingPeriod {
  weekday: number;
}

/** A day's default when the user presses "Add period". */
export function emptyPeriod(): WorkingPeriod {
  return {
    startTime: "09:00",
    endTime: "17:00",
    locationId: null,
    validFrom: null,
    validUntil: null,
    active: true,
  };
}

/**
 * Group the API's rows by weekday, keeping every field.
 *
 * Several periods on one day is the normal case, not an edge case: a lunch break
 * is a gap between two periods rather than a property of one.
 */
export function seedWorkingWeek(rows: WorkingHoursRow[]): WorkingWeek {
  const week: WorkingWeek = {};

  for (const row of rows) {
    (week[row.weekday] ??= []).push({
      startTime: row.startTime,
      endTime: row.endTime,
      locationId: row.locationId,
      validFrom: row.validFrom,
      validUntil: row.validUntil,
      active: row.active,
    });
  }

  return week;
}

/**
 * The whole week, flattened back into what the API replaces it with.
 *
 * `validFrom` and `validUntil` travel as `YYYY-MM-DD` strings and must never be
 * turned into Dates on the way: the server reads them as
 * `new Date(`${validFrom}T00:00:00Z`)` and hands them back with
 * `.toISOString().slice(0, 10)`, so anything carrying a local offset lands on
 * the wrong day everywhere east of UTC.
 */
export function buildWorkingHoursBody(week: WorkingWeek): { workingHours: WorkingHoursInput[] } {
  const workingHours: WorkingHoursInput[] = [];

  for (const weekday of WEEKDAYS) {
    for (const period of week[weekday] ?? []) {
      workingHours.push({ weekday, ...period });
    }
  }

  return { workingHours };
}
