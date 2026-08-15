import {
  addDays,
  formatDateOnly,
  parseDateOnly,
  weekdayOf,
  type DateOnly,
} from "@bam/availability-engine";

/**
 * The month grid behind the booking page's "When" step, as arithmetic.
 *
 * The step used to be one date input and a list of times, so a customer whose
 * chosen day was empty could only guess at another. It is now a month that
 * marks which days hold anything, and this module is everything that decision
 * needs that is not React: which days a month contains, what to ask the API
 * for, which days a response covers, and where an arrow key lands.
 *
 * ## Why none of this is written here twice
 *
 * `@bam/availability-engine` already owns calendar arithmetic — `addDays`,
 * `weekdayOf` (ISO, Monday = 1), `parseDateOnly` — and it is already a
 * dependency of this app. Its versions are tested against daylight-saving
 * transitions, which is the failure this file would otherwise reinvent
 * (CLAUDE.md rule 13). Nothing here parses a date by hand.
 *
 * ## Two properties the code leans on, stated once
 *
 * **A fixed-width `YYYY-MM-DD` sorts chronologically as a string.** That is why
 * {@link isBefore} is a comparison rather than a parse, and why the day keys of
 * a `Map` can be sorted directly.
 *
 * **Month arithmetic is integer arithmetic on `year * 12 + month`.** Never
 * `Date.setMonth`, which overflows: 31 January plus one month is 3 March, so a
 * PageDown from the 31st would skip February entirely. See {@link addMonths}.
 *
 * Nothing here formats for a human — no `Intl`, no locale, no React. Month
 * names, weekday headers and day labels are the component's job, so this stays
 * testable without a DOM, which is the only kind of test this app runs.
 */

/** `YYYY-MM`. A calendar month, with no day and no zone attached. */
export type YearMonth = string;

/**
 * How many months past an empty one to look before giving up.
 *
 * Each lookahead is a real month query sharing the navigation cache, so the
 * cost is bounded and pressing "next month" afterwards is free. Two is where
 * chasing stops being helpful: a business with nothing free for three months
 * is one to telephone, not to keep querying.
 */
export const LOOKAHEAD_MONTHS = 2;

/**
 * The ISO weekday the grid's first column holds. Monday for both `hu` and `en`.
 *
 * If a locale ever needs a Sunday-first week this is the only value to change —
 * {@link buildMonthGrid} derives the leading offset from it.
 */
export const WEEK_STARTS_ON = 1;

/** What the slot search returns, narrowed to the two fields this module reads. */
interface SlotLike {
  startAt: string;
  providerId: string;
}

// ---------------------------------------------------------------------------
// Months
// ---------------------------------------------------------------------------

export function monthOf(date: DateOnly): YearMonth {
  return date.slice(0, 7);
}

function parseMonth(month: YearMonth): { year: number; month: number } {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  if (!match) throw new Error(`Not a YYYY-MM month: ${month}`);

  const [, year, monthPart] = match;
  return { year: Number(year), month: Number(monthPart) };
}

function formatMonth(parts: { year: number; month: number }): YearMonth {
  return `${String(parts.year).padStart(4, "0")}-${String(parts.month).padStart(2, "0")}`;
}

/**
 * Move by whole months.
 *
 * Integer arithmetic on a month index, not `Date.setMonth`. That method keeps
 * the day-of-month and lets it overflow, so "31 January plus one month" is
 * 3 March — which would make PageDown from the 31st skip a month, and only in
 * some months, which is the kind of bug that is found in production in March.
 * Taking a `YearMonth` rather than a date means there is no day to overflow.
 */
export function addMonths(month: YearMonth, count: number): YearMonth {
  const { year, month: monthNumber } = parseMonth(month);
  const index = year * 12 + (monthNumber - 1) + count;

  return formatMonth({ year: Math.floor(index / 12), month: (index % 12) + 1 });
}

export function daysInMonth(month: YearMonth): number {
  const { year, month: monthNumber } = parseMonth(month);
  // Day 0 of the next month is the last day of this one, and `Date.UTC`
  // normalises December → January for us.
  return new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
}

export function firstDayOf(month: YearMonth): DateOnly {
  return `${month}-01`;
}

export function lastDayOf(month: YearMonth): DateOnly {
  return `${month}-${String(daysInMonth(month)).padStart(2, "0")}`;
}

/** Lexicographic comparison is chronological for fixed-width ISO dates. */
export function isBefore(date: DateOnly, other: DateOnly): boolean {
  return date < other;
}

/**
 * The search range for a month, never asking for a day that has already gone.
 *
 * Null when the whole month is in the past: the caller disables the query
 * rather than sending a range, because there is nothing bookable there and the
 * honest request is no request.
 *
 * The clamp is also what keeps every range inside the API's 62-day cap — a
 * whole month is at most 31 days, and the test asserts that across three years
 * so a later widening cannot quietly breach it.
 */
export function monthRangeOf(
  month: YearMonth,
  today: DateOnly,
): { dateFrom: DateOnly; dateTo: DateOnly } | null {
  const dateTo = lastDayOf(month);
  if (isBefore(dateTo, today)) return null;

  const first = firstDayOf(month);
  return { dateFrom: isBefore(first, today) ? today : first, dateTo };
}

// ---------------------------------------------------------------------------
// The grid
// ---------------------------------------------------------------------------

export interface DayCell {
  date: DateOnly;
  /** 1–31 — what the cell prints. */
  dayOfMonth: number;
  /** False for the days borrowed from the adjacent months. */
  inMonth: boolean;
}

/**
 * The weeks a month occupies: 4, 5 or 6 rows of 7, every row starting Monday.
 *
 * The natural count rather than a fixed six. February 2027 is 28 days starting
 * on a Monday and so is exactly four rows — padding it to six would render
 * fourteen cells of pure adjacent-month filler. It is the only such month
 * between 2026 and 2030, which is precisely why nobody would notice the bug
 * until they hit it. The component reserves six rows of height instead, so the
 * buttons below do not move when a five-row month follows a six-row one.
 */
export function buildMonthGrid(month: YearMonth): DayCell[][] {
  const first = firstDayOf(month);
  const length = daysInMonth(month);

  // How many days of the previous month share the first row.
  const leading = (weekdayOf(first) - WEEK_STARTS_ON + 7) % 7;
  const rows = Math.ceil((leading + length) / 7);

  const weeks: DayCell[][] = [];
  let cursor = addDays(first, -leading);

  for (let row = 0; row < rows; row += 1) {
    const week: DayCell[] = [];

    for (let column = 0; column < 7; column += 1) {
      const { day } = parseDateOnly(cursor);
      week.push({ date: cursor, dayOfMonth: day, inMonth: monthOf(cursor) === month });
      cursor = addDays(cursor, 1);
    }

    weeks.push(week);
  }

  return weeks;
}

/**
 * Where an arrow key lands.
 *
 * May leave the visible month — `Home` on the 1st of a month that starts on a
 * Tuesday lands on the last day of the previous one — and the caller is
 * expected to follow it rather than clamp. Clamping is what makes a keyboard
 * user unable to reach the last week of a month at all.
 *
 * PageUp/PageDown clamp only within their target month, so 31 January goes to
 * 28 February rather than to 3 March.
 */
export type CalendarKey =
  | "ArrowLeft"
  | "ArrowRight"
  | "ArrowUp"
  | "ArrowDown"
  | "Home"
  | "End"
  | "PageUp"
  | "PageDown";

export function nextFocusedDay(
  from: DateOnly,
  key: CalendarKey,
  options: { shift?: boolean } = {},
): DateOnly {
  const step = options.shift === true ? 12 : 1;

  switch (key) {
    case "ArrowLeft":
      return addDays(from, -1);
    case "ArrowRight":
      return addDays(from, 1);
    case "ArrowUp":
      return addDays(from, -7);
    case "ArrowDown":
      return addDays(from, 7);
    case "Home":
      return addDays(from, -((weekdayOf(from) - WEEK_STARTS_ON + 7) % 7));
    case "End":
      return addDays(from, 6 - ((weekdayOf(from) - WEEK_STARTS_ON + 7) % 7));
    case "PageUp":
      return clampToMonth(addMonths(monthOf(from), -step), from);
    case "PageDown":
      return clampToMonth(addMonths(monthOf(from), step), from);
  }
}

/** The same day-of-month in another month, or that month's last day. */
function clampToMonth(month: YearMonth, like: DateOnly): DateOnly {
  const { day } = parseDateOnly(like);
  const { year, month: monthNumber } = parseMonth(month);

  return formatDateOnly({ year, month: monthNumber, day: Math.min(day, daysInMonth(month)) });
}

// ---------------------------------------------------------------------------
// Slots
// ---------------------------------------------------------------------------

/**
 * The calendar day an instant falls on, in the browser's zone, as `YYYY-MM-DD`.
 *
 * `toISOString().slice(0, 10)` would be the UTC day, which is a different day
 * for any evening appointment east of Greenwich — including every slot this
 * application currently sells.
 *
 * This has to be the browser's zone rather than any other, because the times
 * beside it are rendered by `Intl.DateTimeFormat` with no `timeZone` option.
 * A 23:30 slot grouped by the UTC day would sit under a heading a day away
 * from the time printed on it.
 */
export function localDayOf(instant: string): DateOnly {
  const at = new Date(instant);
  const year = String(at.getFullYear()).padStart(4, "0");
  const month = String(at.getMonth() + 1).padStart(2, "0");
  const day = String(at.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export interface DaySummary {
  /** Distinct start times, after deduplication across providers. */
  count: number;
  /** The earliest of them, for the "from 09:00" hint. */
  firstStartAt: string;
}

/**
 * One entry per day the response covers, with how many distinct times it holds.
 *
 * Distinct *starts*, not items. The search merges every matching provider into
 * one list without deduplicating, so three providers free at 09:00 are three
 * items — and telling a customer a day has "18 times" when it offers six is a
 * lie the month grid would repeat thirty times over.
 */
export function summariseSlotsByDay(slots: readonly SlotLike[]): Map<DateOnly, DaySummary> {
  const starts = new Map<DateOnly, Set<string>>();

  for (const slot of slots) {
    const date = localDayOf(slot.startAt);
    const seen = starts.get(date) ?? new Set<string>();
    seen.add(slot.startAt);
    starts.set(date, seen);
  }

  const summaries = new Map<DateOnly, DaySummary>();

  for (const [date, seen] of starts) {
    const sorted = [...seen].sort();
    // A day only reaches this map by having a slot, so the first always exists.
    summaries.set(date, { count: sorted.length, firstStartAt: sorted[0] ?? "" });
  }

  return summaries;
}

/**
 * One slot per distinct start instant, earliest first.
 *
 * Which provider survives matters less than that it is the *same* one on every
 * render: a button that silently changes provider between paints books somebody
 * a different person than the one they were looking at. The API sorts by
 * `startAt` then `providerId`, so keeping the first is deterministic.
 *
 * It does mean one provider absorbs every "anyone" booking. Spreading that load
 * is a decision for the API, which knows each provider's utilisation; guessing
 * at it here — by rotating, or randomising — would only make the choice
 * unstable without making it fair.
 */
export function dedupeByStart<T extends SlotLike>(slots: readonly T[]): T[] {
  const byStart = new Map<string, T>();

  for (const slot of slots) {
    if (!byStart.has(slot.startAt)) byStart.set(slot.startAt, slot);
  }

  return [...byStart.values()].sort((left, right) =>
    left.startAt < right.startAt ? -1 : left.startAt > right.startAt ? 1 : 0,
  );
}

/** That day's slots, deduplicated, earliest first. */
export function slotsOnDay<T extends SlotLike>(slots: readonly T[], date: DateOnly): T[] {
  return dedupeByStart(slots.filter((slot) => localDayOf(slot.startAt) === date));
}

/**
 * The earliest day in the month that has anything.
 *
 * What the page selects on arrival, rather than today: today is very often
 * empty — it is half over, and the notice window may have closed it entirely —
 * and opening the step on "nothing free" is the exact failure the month view
 * exists to remove.
 */
export function firstAvailableDay(
  summaries: ReadonlyMap<DateOnly, DaySummary>,
  month: YearMonth,
  today: DateOnly,
): DateOnly | null {
  const candidates = [...summaries.entries()]
    .filter(
      ([date, summary]) =>
        summary.count > 0 && monthOf(date) === month && !isBefore(date, today),
    )
    .map(([date]) => date)
    .sort();

  return candidates[0] ?? null;
}
