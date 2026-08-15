/**
 * "Nothing free on that day" is a dead end. This turns it into a next step.
 *
 * The customer picked one date and got an empty list. Rather than leaving them
 * to guess-and-check a date picker — which is how somebody decides a business
 * has no availability at all and closes the tab — the page searches the days
 * that follow and offers the first few that have something.
 *
 * ## Why this module is pure, and why the grouping is local
 *
 * A slot is an absolute instant (`startAt`), and "which day is that" is a
 * question only a timezone can answer. The page renders every time through
 * `Intl.DateTimeFormat` with no `timeZone` option — that is, in the browser's
 * zone — so the grouping has to use the same zone, or a 23:30 slot would be
 * offered under a heading a day away from the time printed beside it.
 *
 * Nothing here converts an instant by adding an offset by hand (CLAUDE.md rule
 * 13). {@link localDayOf} asks the platform which local day an instant falls
 * on, and {@link addDaysToDateOnly} does calendar arithmetic on a date-only
 * string through UTC, where every day is exactly 24 hours and no daylight-saving
 * transition exists to be wrong about.
 */

/**
 * How far past the requested day to look.
 *
 * Two weeks: long enough to cross a provider who works alternate weeks or is
 * away for a few days, short enough that the answer is still useful to somebody
 * who wanted an appointment "soon". The API caps a single search at 62 days, so
 * this is well inside one request.
 */
export const LOOKAHEAD_DAYS = 14;

/** How many alternative days to offer. More than three is a second date picker. */
export const SUGGESTED_DAYS = 3;

/**
 * Calendar arithmetic on a `YYYY-MM-DD` string.
 *
 * Through UTC deliberately: the input names a calendar day rather than an
 * instant, and local-time arithmetic across a daylight-saving boundary can land
 * on the same date twice or skip one.
 */
export function addDaysToDateOnly(date: string, days: number): string {
  const shifted = new Date(`${date}T00:00:00Z`);
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted.toISOString().slice(0, 10);
}

/**
 * The calendar day an instant falls on, in the browser's zone, as `YYYY-MM-DD`.
 *
 * `toISOString().slice(0, 10)` would be the UTC day, which is a different day
 * for any evening appointment east of Greenwich — including every slot this
 * application currently sells.
 */
export function localDayOf(instant: string): string {
  const at = new Date(instant);
  const year = String(at.getFullYear()).padStart(4, "0");
  const month = String(at.getMonth() + 1).padStart(2, "0");
  const day = String(at.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export interface DayWithSlots {
  /** `YYYY-MM-DD` in the browser's zone — what the date input expects. */
  date: string;
  /** How many start times that day holds. */
  count: number;
  /** The earliest of them, for the "from 09:00" hint. */
  firstStartAt: string;
}

/**
 * The first `limit` days that hold anything, earliest first.
 *
 * Sorted here rather than trusting the response: the API does return slots in
 * time order, but this reads the *first* start time of each day as the one it
 * shows, which is a claim worth making true locally.
 */
export function nextAvailableDays(
  slots: readonly { startAt: string }[],
  limit: number = SUGGESTED_DAYS,
): DayWithSlots[] {
  const byDay = new Map<string, { count: number; firstStartAt: string }>();

  for (const slot of [...slots].sort((left, right) =>
    left.startAt < right.startAt ? -1 : left.startAt > right.startAt ? 1 : 0,
  )) {
    const date = localDayOf(slot.startAt);
    const existing = byDay.get(date);

    if (existing === undefined) byDay.set(date, { count: 1, firstStartAt: slot.startAt });
    else existing.count += 1;
  }

  return [...byDay.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .slice(0, limit)
    .map(([date, entry]) => ({ date, count: entry.count, firstStartAt: entry.firstStartAt }));
}
