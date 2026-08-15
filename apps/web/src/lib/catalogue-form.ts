/**
 * Turning catalogue form state into a request body.
 *
 * ## The asymmetry these helpers exist to hold
 *
 * Create and update bodies are *not* the same shape, and treating them as one
 * is how the create panels ended up unable to clear a field and the edit panels
 * unable to leave one alone:
 *
 *   - `create*BodySchema` is built from `.optional()`. An absent key means "take
 *     the server's default". There is no `null` — `email: null` fails
 *     validation outright.
 *   - `update*BodySchema` is `.partial()` over `.nullable()`. An absent key
 *     means "leave this alone"; an explicit `null` means "clear it". Omitting a
 *     field can therefore never empty it.
 *
 * So an empty text box means two different things depending on which request it
 * is going into, and {@link textValue} is the single place that decides.
 *
 * ## Why `""` is never sent
 *
 * `JSON.stringify` drops `undefined` keys but faithfully transmits `""`, and
 * `z.email()`, `slugSchema` and `timezoneSchema` all reject the empty string.
 * The create panels each dodged this by hand (`...(email === "" ? {} : { email })`);
 * doing it centrally is most of the point of this module.
 */

export type FormMode = "create" | "patch";

/**
 * A text box, as the request wants it.
 *
 * Blank becomes *omitted* on create and *null* on patch. Those are not
 * interchangeable and swapping them produces two different bugs: a 422 on
 * create, and a field that cannot be cleared on edit.
 */
export function textValue(mode: FormMode, value: string): string | null | undefined {
  const trimmed = value.trim();
  if (trimmed !== "") return trimmed;

  return mode === "create" ? undefined : null;
}

/**
 * A number box, same rules.
 *
 * Blank is *not* zero. For `minimumNoticeMinutes` blank means "inherit from the
 * service or tenant" while zero means "bookable up to the last second", and both
 * are real answers a user might want.
 */
export function numberValue(mode: FormMode, value: string): number | null | undefined {
  const trimmed = value.trim();

  if (trimmed === "") return mode === "create" ? undefined : null;

  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * What the availability engine falls back to when a field says "inherit".
 *
 * Mirrors `DEFAULT_MAXIMUM_ADVANCE_DAYS` in
 * `apps/api/src/modules/availability/availability.service.ts`. Duplicated
 * rather than imported because the API is not a library this app links against,
 * and a number shown in a hint that silently disagreed with the engine would be
 * worse than no hint at all — so if that constant moves, this one moves with it.
 */
export const DEFAULT_MAXIMUM_ADVANCE_DAYS = 180;

/** Below this, a booking horizon is more likely a mistake than an intention. */
export const SHORT_HORIZON_DAYS = 7;

export interface AdvanceNote {
  /** The message key under `catalogue` that explains this value. */
  key: "advanceInherit" | "advanceDays" | "advanceShort";
  /** The horizon in days, after inheritance. */
  days: number;
}

/**
 * What "book up to N days ahead" will actually do, in plain language.
 *
 * This exists because of a live incident. A service was saved with
 * `maximum_advance_days = 1`, which means *today and tomorrow and nothing
 * else* — and since the engine intersects that window before it ever looks at
 * a schedule, the booking page went completely empty while every screen in the
 * dashboard still showed a healthy provider with a full week of working hours.
 * It took a database dump to find, because nothing anywhere said what the
 * number meant.
 *
 * A blank box is the other half of the same problem: it inherits 180 days, and
 * the form gave no clue that a default existed at all.
 *
 * The most restrictive value wins across provider *and* service, so a horizon
 * set here can be shortened elsewhere — the note deliberately describes this
 * field rather than promising an outcome.
 */
export function advanceNote(value: string): AdvanceNote {
  const trimmed = value.trim();
  if (trimmed === "") return { key: "advanceInherit", days: DEFAULT_MAXIMUM_ADVANCE_DAYS };

  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return { key: "advanceInherit", days: DEFAULT_MAXIMUM_ADVANCE_DAYS };
  }

  return parsed < SHORT_HORIZON_DAYS
    ? { key: "advanceShort", days: parsed }
    : { key: "advanceDays", days: parsed };
}

/**
 * Only the fields that actually changed.
 *
 * Catalogue rows carry no `version` column — unlike `Booking`, which does — so
 * there is no optimistic-concurrency check available. A PATCH carrying every
 * field therefore blindly overwrites whatever a colleague changed since this
 * page loaded. Diffing narrows last-writer-wins from the whole row down to the
 * fields this user actually touched, which is not a guarantee but is a great
 * deal better than the alternative for the price of fifteen lines.
 *
 * Array values compare by content: `languages` is a set the user edits with
 * checkboxes, and a fresh array with the same members is not a change.
 */
export function diffPatch<T extends Record<string, unknown>>(before: T, after: T): Partial<T> {
  const patch: Record<string, unknown> = {};

  for (const key of Object.keys(after)) {
    const next = after[key];
    const previous = before[key];

    if (Array.isArray(next) && Array.isArray(previous)) {
      if (next.length === previous.length && next.every((item, at) => item === previous[at])) {
        continue;
      }
    } else if (next === previous) {
      continue;
    }

    patch[key] = next;
  }

  return patch as Partial<T>;
}

/**
 * The locales a tenant may translate into and a provider may speak. Mirrors
 * `languageSchema` in `@bam/contracts`; the API rejects anything else.
 */
export const LOCALES = ["hu", "en", "de", "fr"] as const;

/**
 * IANA zones for a `<datalist>`, or an empty list where the browser cannot
 * enumerate them.
 *
 * A suggestion list, never a constraint: the input stays free text and the
 * server validates with `timezoneSchema` regardless, so an older browser degrades
 * to typing the zone rather than to being unable to set one.
 */
export function supportedTimeZones(): string[] {
  const supported = (Intl as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf;
  if (typeof supported !== "function") return [];

  try {
    return supported("timeZone");
  } catch {
    return [];
  }
}
