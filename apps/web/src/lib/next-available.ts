import { summariseSlotsByDay, type DaySummary } from "./month-availability";
import type { DateOnly } from "@bam/availability-engine";

/**
 * Where to send a customer when the month they are looking at holds nothing.
 *
 * This file used to own the whole "nothing free on that day" answer: a 14-day
 * lookahead and three suggestion chips beside a date input. The month grid took
 * most of that over — a day with times is now marked on the calendar, so
 * offering the same day again as a chip says nothing new — and what survives is
 * the one question the grid cannot answer, because it only ever shows one
 * month: *where is the next free day at all?*
 *
 * The day-grouping arithmetic, and `localDayOf` with it, moved to
 * `./month-availability`. Import those from there; this file depends on that
 * one and never the other way round.
 */

export interface DayWithSlots extends DaySummary {
  date: DateOnly;
}

/**
 * The first `limit` days that hold anything, earliest first.
 *
 * Built on {@link summariseSlotsByDay} so a day's count means the same thing
 * here as it does on a calendar cell — distinct start times, not one entry per
 * provider offering the same one.
 */
export function nextAvailableDays(
  slots: readonly { startAt: string; providerId: string }[],
  limit = 1,
): DayWithSlots[] {
  return [...summariseSlotsByDay(slots).entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .slice(0, limit)
    .map(([date, summary]) => ({ date, ...summary }));
}

/**
 * The earliest free day across the lookahead months, or null.
 *
 * The months arrive as separate query results — each one a real month search
 * sharing the navigation cache — so they are concatenated rather than merged in
 * order: the sort inside {@link nextAvailableDays} puts them right regardless
 * of which resolved first, and a caller passing them out of order still gets
 * the earliest day.
 */
export function firstAcrossMonths(
  months: readonly (readonly { startAt: string; providerId: string }[])[],
): DayWithSlots | null {
  return nextAvailableDays(months.flat(), 1)[0] ?? null;
}
