/**
 * Wall-clock ↔ instant conversion in an IANA time zone. tech-impl §13.4.
 *
 * ## Why this is hand-written
 *
 * The engine takes no dependencies at all (tech-impl §13), and it needs exactly
 * two operations: "what is the UTC instant of 09:00 local on this date in this
 * zone", and its inverse. Both are derivable from `Intl.DateTimeFormat`, which
 * carries the platform's own IANA database — the same source a date library
 * would consult.
 *
 * The rule this file exists to enforce is §13.4's: recurring working hours are
 * stored as local wall-clock time and interpreted in the provider's zone. They
 * are never computed by adding a fixed UTC offset, because the offset is not
 * fixed — that is the whole difficulty. A clinic open "09:00–17:00 on Mondays"
 * is open 09:00–17:00 on the Monday the clocks change too, and that Monday is
 * 23 or 25 hours long.
 *
 * ## Two hours a day does not have
 *
 * Twice a year a wall-clock time is either impossible or repeated:
 *
 *   Spring forward — 02:30 on the transition day does not exist. Asking for it
 *                    is a schedule that says something the calendar cannot
 *                    honour, so it resolves forward to the first real instant
 *                    (03:00), and the caller can detect it via `resolution`.
 *   Autumn back    — 02:30 happens twice, an hour apart. The earlier instant
 *                    wins, which is the convention every calendar application
 *                    uses and the one that keeps a working day from silently
 *                    starting an hour late.
 *
 * Neither case is left implicit: {@link resolveWallClock} reports which one it
 * hit, so the engine can decide rather than inherit an accident.
 */

/** A date and time with no zone attached — what a schedule actually stores. */
export interface WallClock {
  /** Full year, e.g. 2026. */
  year: number;
  /** 1–12. Not the 0-based month `Date` uses; that off-by-one is not worth
   *  carrying through an entire package. */
  month: number;
  /** 1–31. */
  day: number;
  /** 0–23. */
  hour: number;
  /** 0–59. */
  minute: number;
}

export type WallClockResolution =
  /** The wall-clock time exists exactly once. The ordinary case. */
  | "exact"
  /** It does not exist (clocks sprang forward over it); snapped forward. */
  | "skipped"
  /** It happens twice (clocks fell back); the earlier instant was taken. */
  | "ambiguous";

export interface ResolvedWallClock {
  /** Milliseconds since the epoch. */
  epochMs: number;
  resolution: WallClockResolution;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

/**
 * Formatters are expensive to construct and are asked the same question
 * thousands of times during a slot search, so they are cached per zone. The map
 * is bounded in practice by how many zones one deployment serves.
 */
const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatterCache.get(timeZone);

  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatterCache.set(timeZone, formatter);
  }

  return formatter;
}

/** True if the runtime recognises this zone. */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

/**
 * What the clock reads in `timeZone` at a given instant.
 *
 * Seconds are dropped: every input this engine handles is minute-aligned, and
 * carrying seconds only invites a rounding question nobody wants to answer
 * halfway through a slot calculation.
 */
export function toWallClock(epochMs: number, timeZone: string): WallClock {
  const parts = formatterFor(timeZone).formatToParts(new Date(epochMs));
  const read = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((candidate) => candidate.type === type);
    if (!part) throw new Error(`Intl did not return a ${type} part for zone ${timeZone}`);
    return Number(part.value);
  };

  return {
    year: read("year"),
    month: read("month"),
    day: read("day"),
    hour: read("hour"),
    minute: read("minute"),
  };
}

/**
 * The zone's offset from UTC at a given instant, in milliseconds.
 *
 * Derived by asking what the clock reads there and comparing it to what the
 * clock reads in UTC. Positive east of Greenwich.
 */
export function offsetAt(epochMs: number, timeZone: string): number {
  const local = toWallClock(epochMs, timeZone);

  const asIfUtc = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute);

  // The instant is minute-aligned on the local side but not necessarily on the
  // UTC side, so compare against the truncated instant rather than the raw one.
  // Zones with sub-minute historical offsets exist, but none since 1972.
  return asIfUtc - Math.floor(epochMs / MINUTE_MS) * MINUTE_MS;
}

/**
 * The UTC instant at which `wall` reads on the clock in `timeZone`.
 *
 * ## The algorithm
 *
 * Treat the wall-clock time as though it were UTC, which gives an instant
 * wrong by exactly the zone's offset. Look up the offset *there* and subtract
 * it. That lands in the right neighbourhood but can still be an hour out when
 * the guess fell on the far side of a transition, so the offset is looked up
 * once more at the corrected instant and applied again. Two passes is provably
 * enough for the ≤ 2-hour transitions every real zone uses.
 *
 * Then verify: format the candidate back and check it reads what was asked for.
 * A mismatch means the wall-clock time does not exist, which is reported rather
 * than papered over.
 */
export function resolveWallClock(wall: WallClock, timeZone: string): ResolvedWallClock {
  const exact = attempt(wall, timeZone);

  if (exact !== null) {
    // The time exists. It may still exist *twice* — during a fall-back hour the
    // same reading occurs at two instants, and the two-pass search can land on
    // either. If an hour earlier reads the same, that earlier instant is the
    // one to return.
    const anHourEarlier = exact - HOUR_MS;

    if (readsAs(anHourEarlier, wall, timeZone)) {
      return { epochMs: anHourEarlier, resolution: "ambiguous" };
    }

    return { epochMs: exact, resolution: "exact" };
  }

  // The reading does not exist: the clocks jumped over it. Walk forward a
  // minute at a time to the first reading that does. Walking rather than
  // assuming a one-hour gap means Lord Howe's 30-minute shift, and any historic
  // oddity, resolves correctly instead of merely plausibly.
  for (let minutes = 1; minutes <= 180; minutes += 1) {
    const shifted = shiftMinutes(wall, minutes);
    const resolved = attempt(shifted, timeZone);

    if (resolved !== null) {
      return { epochMs: resolved, resolution: "skipped" };
    }
  }

  // Unreachable for any zone in the IANA database. Failing loudly beats
  // returning an instant that is quietly an hour wrong.
  throw new Error(
    `Could not resolve ${String(wall.year)}-${pad(wall.month)}-${pad(wall.day)} ` +
      `${pad(wall.hour)}:${pad(wall.minute)} in ${timeZone}`,
  );
}

/**
 * The instant for a wall-clock reading, or null when that reading does not
 * exist in this zone.
 *
 * Two passes: treat the reading as UTC to get an instant wrong by the offset,
 * correct by the offset found there, then correct again in case the first guess
 * fell on the far side of a transition. Two is provably enough for the ≤ 2-hour
 * transitions every real zone uses — and the result is verified rather than
 * trusted, which is what makes the third pass unnecessary.
 */
function attempt(wall: WallClock, timeZone: string): number | null {
  const asIfUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute);

  const firstGuess = asIfUtc - offsetAt(asIfUtc, timeZone);
  const candidate = asIfUtc - offsetAt(firstGuess, timeZone);

  return readsAs(candidate, wall, timeZone) ? candidate : null;
}

/** Add minutes to a wall-clock reading, carrying into hours, days and months. */
function shiftMinutes(wall: WallClock, minutes: number): WallClock {
  const shifted = new Date(
    Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute + minutes),
  );

  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
  };
}

/** Convenience for the common case: the instant, ignoring how it resolved. */
export function wallClockToEpochMs(wall: WallClock, timeZone: string): number {
  return resolveWallClock(wall, timeZone).epochMs;
}

/** Does the clock in `timeZone` read exactly `wall` at this instant? */
function readsAs(epochMs: number, wall: WallClock, timeZone: string): boolean {
  const actual = toWallClock(epochMs, timeZone);

  return (
    actual.year === wall.year &&
    actual.month === wall.month &&
    actual.day === wall.day &&
    actual.hour === wall.hour &&
    actual.minute === wall.minute
  );
}

// ---------------------------------------------------------------------------
// Calendar-date helpers
//
// The engine walks days in the provider's zone, not in UTC — "Monday" means the
// Monday they experience. These keep that arithmetic in one place.
// ---------------------------------------------------------------------------

/** `YYYY-MM-DD`, no zone attached. */
export type DateOnly = string;

export function parseDateOnly(date: DateOnly): { year: number; month: number; day: number } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) throw new Error(`Not a YYYY-MM-DD date: ${date}`);

  const [, year, month, day] = match;
  return { year: Number(year), month: Number(month), day: Number(day) };
}

export function formatDateOnly(parts: { year: number; month: number; day: number }): DateOnly {
  return `${String(parts.year).padStart(4, "0")}-${pad(parts.month)}-${pad(parts.day)}`;
}

/** The calendar date in `timeZone` at a given instant. */
export function dateOnlyAt(epochMs: number, timeZone: string): DateOnly {
  return formatDateOnly(toWallClock(epochMs, timeZone));
}

/**
 * `count` days after `date`, on the calendar.
 *
 * Done with UTC arithmetic on a zoneless date, which is safe precisely because
 * no zone is involved: adding a day to a calendar date is a calendar operation,
 * and a day here is always one calendar day even when it is 23 hours long.
 */
export function addDays(date: DateOnly, count: number): DateOnly {
  const { year, month, day } = parseDateOnly(date);
  const shifted = new Date(Date.UTC(year, month - 1, day + count));

  return formatDateOnly({
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  });
}

/** ISO 8601 weekday: Monday = 1 … Sunday = 7, matching `weekdaySchema`. */
export function weekdayOf(date: DateOnly): number {
  const { year, month, day } = parseDateOnly(date);
  const sundayZero = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return sundayZero === 0 ? 7 : sundayZero;
}

/** Every calendar date from `from` to `to`, inclusive. */
export function eachDate(from: DateOnly, to: DateOnly): DateOnly[] {
  const dates: DateOnly[] = [];

  for (let cursor = from; cursor <= to; cursor = addDays(cursor, 1)) {
    dates.push(cursor);

    // A transposed range would otherwise spin until it ran out of memory.
    if (dates.length > 3660) {
      throw new Error(`Date range ${from}..${to} is longer than ten years`);
    }
  }

  return dates;
}

/** `HH:mm` → minutes since midnight. */
export function parseTimeOfDay(time: string): number {
  const match = /^(\d{2}):(\d{2})$/.exec(time);
  if (!match) throw new Error(`Not an HH:mm time: ${time}`);

  const [, hour, minute] = match;
  const hours = Number(hour);
  const minutes = Number(minute);

  // 24:00 is accepted as a way to say "end of day", which is how a working
  // period that runs to midnight has to be written.
  if (hours > 24 || minutes > 59 || (hours === 24 && minutes !== 0)) {
    throw new Error(`Not a valid time of day: ${time}`);
  }

  return hours * 60 + minutes;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}
