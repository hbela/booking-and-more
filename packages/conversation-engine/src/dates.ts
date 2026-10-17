import {
  addDays,
  dateOnlyAt,
  resolveWallClock,
  weekdayOf,
  type DateOnly,
  type WallClockResolution,
} from "@bam/availability-engine";

/**
 * Natural-language dates, resolved by us. tech-impl §24.
 *
 * The hybrid the spec describes: the model extracts *expressions* — "jövő
 * kedden", "next Tuesday", "délután" — and this converts them. It never asks the
 * model for an instant.
 *
 * The reason is CLAUDE.md rule 13. A wall-clock reading is not an instant until
 * a zone has been applied to it, a stored offset is right for half the year, and
 * a model asked to compute "next Tuesday at 2pm in Europe/Budapest" as ISO will
 * be an hour wrong twice a year and equally confident both times. Every
 * conversion here goes through `@bam/availability-engine`'s `zone.ts`, which is
 * the only code in the product allowed to do that arithmetic — and which reports
 * when a reading was skipped or repeated by a daylight-saving transition instead
 * of silently picking one.
 */

/** Minutes since midnight, in the conversation's zone. */
export type MinuteOfDay = number;

export interface Daypart {
  from: MinuteOfDay;
  to: MinuteOfDay;
}

/**
 * What "morning" means.
 *
 * A constant table rather than a tenant setting, for now. tech-impl §31 makes
 * dayparts tenant-configurable for the provider-side commands; exporting the
 * table means that becomes a lookup change rather than a rewrite, and until then
 * every tenant means the same thing by "afternoon", which is at least honest.
 */
export const DAYPARTS: Record<"morning" | "afternoon" | "evening", Daypart> = {
  morning: { from: 8 * 60, to: 12 * 60 },
  afternoon: { from: 12 * 60, to: 17 * 60 },
  evening: { from: 17 * 60, to: 21 * 60 },
};

/** How far ahead "no date given" looks. Matches what the form's picker offers. */
export const DEFAULT_SEARCH_WINDOW_DAYS = 14;

/** Widened around an exact time, so "at 5" is not a search for one instant. */
const AROUND_TIME_MINUTES = 90;

export interface ResolvedDateRange {
  dateFrom: DateOnly;
  dateTo: DateOnly;
  timeFrom?: MinuteOfDay;
  timeTo?: MinuteOfDay;
  /**
   * Set when the phrasing admits more than one reading and we picked one.
   *
   * The caller does not have to act on it — the absolute date is shown before
   * any write regardless (PRD §10.2) — but it is what lets the assistant say
   * "Tuesday the 18th" rather than repeating the customer's own ambiguous words
   * back at them.
   */
  assumption?: "NEXT_WEEK_ASSUMED" | "UPCOMING_ASSUMED" | "DEFAULT_WINDOW";
}

export type DateRefusal = "UNRECOGNISED_DATE" | "UNRECOGNISED_TIME";

export type DateResolution =
  { ok: true; range: ResolvedDateRange } | { ok: false; reason: DateRefusal; expression: string };

// ---------------------------------------------------------------------------
// Vocabulary
//
// Hungarian and English, because those are the two locales the product ships
// (PRD §12.5). Matching is done on a normalised string rather than by locale, so
// a Hungarian customer who types "tomorrow" is understood — people mix.
// ---------------------------------------------------------------------------

const WEEKDAYS: Record<string, number> = {
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
  sunday: 7,
  hetfo: 1,
  kedd: 2,
  szerda: 3,
  csutortok: 4,
  pentek: 5,
  szombat: 6,
  vasarnap: 7,
};

/** Markers that push a weekday into the following week. */
const NEXT_MARKERS = ["next", "jovo", "kovetkezo"];

const TODAY_WORDS = ["today", "ma", "mai"];
const TOMORROW_WORDS = ["tomorrow", "holnap", "holnapi"];
const DAY_AFTER_WORDS = ["day after tomorrow", "holnaputan"];

/**
 * Month names and their common abbreviations, already accent-stripped.
 *
 * Matched as a prefix of a word, so "okt", "okt." and "oktober" all land on
 * October and "szept" covers "szeptember".
 */
const MONTHS: Record<string, number> = {
  januar: 1,
  january: 1,
  jan: 1,
  februar: 2,
  february: 2,
  febr: 2,
  feb: 2,
  marcius: 3,
  march: 3,
  marc: 3,
  mar: 3,
  aprilis: 4,
  april: 4,
  apr: 4,
  majus: 5,
  may: 5,
  maj: 5,
  junius: 6,
  june: 6,
  jun: 6,
  julius: 7,
  july: 7,
  jul: 7,
  augusztus: 8,
  august: 8,
  aug: 8,
  szeptember: 9,
  september: 9,
  szept: 9,
  sept: 9,
  szep: 9,
  sep: 9,
  oktober: 10,
  october: 10,
  okt: 10,
  oct: 10,
  november: 11,
  nov: 11,
  december: 12,
  dec: 12,
};

const MONTH_NAME = `(${Object.keys(MONTHS)
  .sort((a, b) => b.length - a.length)
  .join("|")})[a-z]*\\.?`;
/** "október 26", "okt. 26.", "October 26th", "2026. október 26." */
const MONTH_THEN_DAY = new RegExp(`\\b${MONTH_NAME}\\s*(\\d{1,2})(?!\\d)`, "u");
/** "26 October", "26th of Oct" */
const DAY_THEN_MONTH = new RegExp(
  `(?<!\\d)(\\d{1,2})(?:st|nd|rd|th)?\\.?\\s*(?:of\\s+)?${MONTH_NAME}`,
  "u",
);
const YEAR = /\b(20\d{2})\b/u;

const ISO_DATE = /\b(\d{4})-(\d{2})-(\d{2})\b/u;
const CLOCK_TIME = /\b(\d{1,2})[:.](\d{2})\b/u;
const BARE_HOUR = /\b(\d{1,2})\s*(?:o'?clock|ora|orakor|kor|h)\b/u;

/**
 * Lower-case, strip Hungarian accents, collapse whitespace.
 *
 * Accents are stripped rather than matched because a customer typing on a phone
 * keyboard set to English writes "kedden" as often as "kedden" — and because a
 * transcript from a speech model is not consistent about them either.
 */
function normalize(value: string): string {
  return value
    .toLocaleLowerCase("hu")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

function includesAny(haystack: string, needles: readonly string[]): boolean {
  return needles.some((needle) => haystack.includes(needle));
}

/** The weekday named in the phrase, if any. Longest match wins ("szerda" before "szer"). */
function weekdayIn(phrase: string): number | undefined {
  const names = Object.keys(WEEKDAYS).sort((a, b) => b.length - a.length);
  const found = names.find((name) => phrase.includes(name));

  return found === undefined ? undefined : WEEKDAYS[found];
}

/**
 * The next calendar date on which `weekday` falls.
 *
 * Two readings of "next Tuesday" exist and speakers of both are certain theirs
 * is the only one, so the rule is stated rather than guessed at:
 *
 *  - **With a marker** ("next", "jövő") the Tuesday of the *following* week.
 *    This is what "jövő kedden" means in Hungarian and it is the reading that
 *    surprises fewest people when a marker is present.
 *  - **Without one** ("on Tuesday", "kedden") the next Tuesday strictly after
 *    today — including tomorrow, excluding today, because somebody who means
 *    today says "today".
 *
 * Either way the resolved date is shown to the customer in absolute form before
 * anything is written, which is what actually protects them from the reading we
 * did not choose.
 */
function nextWeekdayDate(today: DateOnly, weekday: number, nextWeek: boolean): DateOnly {
  const todayWeekday = weekdayOf(today);

  if (nextWeek) {
    // Monday of next week, then forward to the named day.
    const mondayOfNextWeek = addDays(today, 8 - todayWeekday);
    return addDays(mondayOfNextWeek, weekday - 1);
  }

  const delta = (weekday - todayWeekday + 7) % 7;
  return addDays(today, delta === 0 ? 7 : delta);
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/**
 * A named month and day — "október 26", "26 October" — as a date.
 *
 * Read from the date phrase alone, never the time phrase, so "10" in "10
 * órakor" cannot become a day. A year, when given, is taken at its word;
 * without one the date is the next occurrence, so in December "január 5" is
 * next January rather than eleven months ago.
 *
 * `null` is a date that does not exist ("február 30"), which is a refusal —
 * `undefined` is a phrase that names no month at all.
 */
function calendarDateIn(dateExpression: string, today: DateOnly): DateOnly | null | undefined {
  const monthFirst = MONTH_THEN_DAY.exec(dateExpression);
  const dayFirst = monthFirst ? null : DAY_THEN_MONTH.exec(dateExpression);

  let month: number;
  let day: number;
  if (monthFirst) {
    month = MONTHS[monthFirst[1]!]!;
    day = Number(monthFirst[2]);
  } else if (dayFirst) {
    month = MONTHS[dayFirst[2]!]!;
    day = Number(dayFirst[1]);
  } else {
    return undefined;
  }

  const statedYear = YEAR.exec(dateExpression);
  const thisYear = Number(today.slice(0, 4));
  const candidate = (year: number) => `${year}-${pad(month)}-${pad(day)}`;

  // Day 1–31 is not enough: Date.UTC rolls 30 February into March.
  const exists = (year: number) => {
    const probe = new Date(Date.UTC(year, month - 1, day));
    return probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day;
  };

  if (statedYear) {
    const year = Number(statedYear[1]);
    return exists(year) ? candidate(year) : null;
  }

  // 29 February resolves to the next year that has one only if it is this
  // year or next; beyond that nobody is booking it.
  for (const year of [thisYear, thisYear + 1]) {
    if (exists(year) && candidate(year) >= today) return candidate(year);
  }

  return null;
}

/** The daypart or clock time in a phrase, as a minute range. */
function resolveTime(phrase: string): Daypart | undefined {
  if (includesAny(phrase, ["morning", "reggel", "delelott"])) return DAYPARTS.morning;
  if (includesAny(phrase, ["afternoon", "delutan"])) return DAYPARTS.afternoon;
  if (includesAny(phrase, ["evening", "este", "night", "ejjel"])) return DAYPARTS.evening;
  // "noon"/"dél" is a point, not a part of the day; treat it as an "around".
  if (includesAny(phrase, ["noon", "delben"])) {
    return { from: 12 * 60 - AROUND_TIME_MINUTES / 2, to: 12 * 60 + AROUND_TIME_MINUTES / 2 };
  }

  const clock = CLOCK_TIME.exec(phrase);
  if (clock) {
    const hour = Number(clock[1]);
    const minute = Number(clock[2]);
    if (hour <= 23 && minute <= 59) return around(hour * 60 + minute);
  }

  const bare = BARE_HOUR.exec(phrase);
  if (bare) {
    let hour = Number(bare[1]);
    if (hour > 24) return undefined;
    // "at 5" in a booking context means 17:00 far more often than 05:00 — no
    // clinic in this product opens at five in the morning, and the customer sees
    // the absolute time before confirming either way.
    if (hour >= 1 && hour <= 7) hour += 12;
    if (hour <= 23) return around(hour * 60);
  }

  return undefined;
}

function around(minute: MinuteOfDay): Daypart {
  return {
    from: Math.max(0, minute - AROUND_TIME_MINUTES / 2),
    to: Math.min(24 * 60, minute + AROUND_TIME_MINUTES / 2),
  };
}

/**
 * Turn what the customer said into a date range to search.
 *
 * `now` is a parameter rather than a call to the clock, so this is pure and so a
 * test can sit on a daylight-saving boundary deliberately.
 */
export function resolveDateExpression(args: {
  /** The date phrase the model extracted. Absent means "no preference". */
  dateExpression?: string | undefined;
  /** The time phrase, if there was one. */
  timeExpression?: string | undefined;
  timezone: string;
  now: Date;
  /** How far ahead to look when no date was given. */
  windowDays?: number;
}): DateResolution {
  const today = dateOnlyAt(args.now.getTime(), args.timezone);
  const phrase = normalize(`${args.dateExpression ?? ""} ${args.timeExpression ?? ""}`);

  const time =
    args.timeExpression === undefined ? undefined : resolveTime(normalize(args.timeExpression));

  if (args.timeExpression !== undefined && time === undefined) {
    return { ok: false, reason: "UNRECOGNISED_TIME", expression: args.timeExpression };
  }

  // A time on its own is a preference about every day in the default window,
  // not a reason to fail.
  if (args.dateExpression === undefined || phrase === "") {
    return {
      ok: true,
      range: withTime(
        {
          dateFrom: today,
          dateTo: addDays(today, args.windowDays ?? DEFAULT_SEARCH_WINDOW_DAYS),
          assumption: "DEFAULT_WINDOW",
        },
        time,
      ),
    };
  }

  const iso = ISO_DATE.exec(phrase);
  if (iso) {
    const date = `${iso[1]}-${iso[2]}-${iso[3]}`;
    return { ok: true, range: withTime({ dateFrom: date, dateTo: date }, time) };
  }

  // Before every word list: "március" contains "ma", "október 26 hétfő" names a
  // weekday, and a named day of a named month beats both. A weekday given
  // alongside it ("október 26 hétfő") is the customer's own check, not a second
  // instruction — the absolute date is read back before anything is written.
  const calendarDate = calendarDateIn(normalize(args.dateExpression), today);
  if (calendarDate === null) {
    return { ok: false, reason: "UNRECOGNISED_DATE", expression: args.dateExpression };
  }
  if (calendarDate !== undefined) {
    return {
      ok: true,
      range: withTime({ dateFrom: calendarDate, dateTo: calendarDate }, time),
    };
  }

  if (includesAny(phrase, DAY_AFTER_WORDS)) {
    const date = addDays(today, 2);
    return { ok: true, range: withTime({ dateFrom: date, dateTo: date }, time) };
  }

  if (includesAny(phrase, TOMORROW_WORDS)) {
    const date = addDays(today, 1);
    return { ok: true, range: withTime({ dateFrom: date, dateTo: date }, time) };
  }

  if (includesAny(phrase, TODAY_WORDS)) {
    return { ok: true, range: withTime({ dateFrom: today, dateTo: today }, time) };
  }

  const nextWeek = includesAny(phrase, NEXT_MARKERS);
  const weekday = weekdayIn(phrase);

  if (weekday !== undefined) {
    const date = nextWeekdayDate(today, weekday, nextWeek);
    return {
      ok: true,
      range: withTime(
        {
          dateFrom: date,
          dateTo: date,
          assumption: nextWeek ? "NEXT_WEEK_ASSUMED" : "UPCOMING_ASSUMED",
        },
        time,
      ),
    };
  }

  // "next week" / "jövő héten" with no day named: the whole of it.
  if (nextWeek && includesAny(phrase, ["week", "heten", "het"])) {
    const monday = addDays(today, 8 - weekdayOf(today));
    return {
      ok: true,
      range: withTime({ dateFrom: monday, dateTo: addDays(monday, 6) }, time),
    };
  }

  if (includesAny(phrase, ["this week", "ezen a heten", "e heten"])) {
    return {
      ok: true,
      range: withTime({ dateFrom: today, dateTo: addDays(today, 7 - weekdayOf(today)) }, time),
    };
  }

  return { ok: false, reason: "UNRECOGNISED_DATE", expression: args.dateExpression };
}

function withTime(range: ResolvedDateRange, time: Daypart | undefined): ResolvedDateRange {
  if (time === undefined) return range;

  return { ...range, timeFrom: time.from, timeTo: time.to };
}

/**
 * A local date and minute-of-day as an actual instant, with the honest answer
 * about whether that reading exists.
 *
 * `resolution` is passed through rather than swallowed: `"skipped"` means the
 * clocks jumped over the time the customer named, `"ambiguous"` means it happens
 * twice that day. Both are worth saying out loud on the two mornings a year they
 * occur, and both are invisible to anything that adds an offset by hand.
 */
export function instantFor(args: { date: DateOnly; minuteOfDay: MinuteOfDay; timezone: string }): {
  epochMs: number;
  resolution: WallClockResolution;
} {
  const [year, month, day] = args.date.split("-").map(Number) as [number, number, number];

  return resolveWallClock(
    {
      year,
      month,
      day,
      hour: Math.floor(args.minuteOfDay / 60),
      minute: args.minuteOfDay % 60,
    },
    args.timezone,
  );
}
