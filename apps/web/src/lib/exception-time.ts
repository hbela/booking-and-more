import { resolveWallClock, toWallClock, type WallClockResolution } from "@bam/availability-engine";

/**
 * Turning what a `datetime-local` input holds into the instant an availability
 * exception actually names.
 *
 * ## The bug this exists to fix
 *
 * `<input type="datetime-local">` yields `YYYY-MM-DDTHH:mm` with no zone at all,
 * and `new Date(value)` resolves it in *the browser's* zone. That is right for
 * staff sitting at the clinic and wrong for anyone else: an administrator in
 * London closing a Budapest diary for "Monday 09:00" was storing 10:00 local
 * (phase-3 §5.6).
 *
 * The provider's zone is the answer, and the conversion goes through
 * `@bam/availability-engine` rather than being hand-rolled here. CLAUDE.md rule
 * 13 says so in as many words, and the reason is on the record: the engine's own
 * predecessor assumed every DST transition was an hour, which returned the wrong
 * instant for Lord Howe Island's 30-minute shift while reporting it as exact
 * (phase-3 §2.2.1). `resolveWallClock` walks instead of assuming, and — the part
 * a hand-rolled version cannot give us at all — says whether the reading was
 * skipped or repeated, so the form can warn before the user commits.
 *
 * Note the asymmetry with `./working-hours`, and keep it: an exception names a
 * moment and converts; a weekly schedule is wall-clock and does not.
 */

/** `YYYY-MM-DDTHH:mm`, optionally with seconds some browsers add. */
const LOCAL_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/;

export interface ResolvedException {
  /** ISO 8601 with offset, ready for the API. */
  instant: string;
  resolution: WallClockResolution;
}

/**
 * Resolve one `datetime-local` value in the provider's zone.
 *
 * Returns null for a value the input has not finished producing, so a caller can
 * simply not warn yet rather than having to distinguish "empty" from "broken".
 */
export function resolveInZone(value: string, timeZone: string): ResolvedException | null {
  const match = LOCAL_DATE_TIME.exec(value);
  if (!match) return null;

  const [, year, month, day, hour, minute] = match;

  const { epochMs, resolution } = resolveWallClock(
    {
      year: Number(year),
      month: Number(month),
      day: Number(day),
      hour: Number(hour),
      minute: Number(minute),
    },
    timeZone,
  );

  return { instant: new Date(epochMs).toISOString(), resolution };
}

/**
 * The inverse, for loading an existing exception back into the form.
 *
 * Goes through the engine's `toWallClock` rather than `toLocaleString`, so what
 * the form shows is the same reading the save will produce.
 */
export function toLocalInputValue(instant: string, timeZone: string): string {
  const wall = toWallClock(new Date(instant).getTime(), timeZone);

  const pad = (value: number, width = 2): string => String(value).padStart(width, "0");
  return `${pad(wall.year, 4)}-${pad(wall.month)}-${pad(wall.day)}T${pad(wall.hour)}:${pad(wall.minute)}`;
}

/**
 * An instant as it reads in the provider's zone.
 *
 * The list had the mirror image of the input bug: it rendered with
 * `toLocaleString()`, which is the *reader's* zone. Fixing only the write half
 * would leave an administrator entering 09:00 and being shown 08:00 back.
 */
export function formatInZone(instant: string, timeZone: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    timeZone,
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(instant));
}
