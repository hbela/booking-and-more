/**
 * How long ago something happened, as an `Intl.RelativeTimeFormat` argument.
 *
 * Pure and unit-tested, for the reason `working-hours.ts` and `member-diary.ts`
 * next door are: the bucketing is the decision, and a decision rendered inside a
 * component is a decision nothing checks.
 *
 * Returning `(value, unit)` rather than a string is what keeps this locale-free.
 * The caller formats with the locale it already has, so Hungarian gets "5 perce"
 * without a single message key — and the alternative, a key per bucket in both
 * catalogues, gets plurals wrong in exactly the language that has the harder
 * rules.
 *
 * Values are **negative**, because every use is in the past. `numeric: "auto"`
 * then turns 0 into "now" rather than "in 0 seconds".
 */
export function relativeAge(
  at: string | Date,
  now: Date,
): { value: number; unit: Intl.RelativeTimeFormatUnit } {
  const then = at instanceof Date ? at : new Date(at);
  const seconds = (then.getTime() - now.getTime()) / 1000;

  // Clamped at 0: a clock skewed a few seconds fast would otherwise render a
  // save as happening "in 4 seconds", which reads as a bug in the screen rather
  // than in the clock.
  const elapsed = Math.max(0, -seconds);

  // `floor`, not `round`. "59 minutes ago" becoming "1 hour ago" is fine;
  // "31 seconds ago" becoming "1 minute ago" claims more precision than we have
  // and, at the boundary that matters here, would round a change that happened
  // *during* your edit up into one that looks older than your session.
  if (elapsed < 60) return { value: 0, unit: "second" };
  if (elapsed < 3600) return { value: -Math.floor(elapsed / 60), unit: "minute" };
  if (elapsed < 86_400) return { value: -Math.floor(elapsed / 3600), unit: "hour" };
  if (elapsed < 2_592_000) return { value: -Math.floor(elapsed / 86_400), unit: "day" };
  if (elapsed < 31_536_000) return { value: -Math.floor(elapsed / 2_592_000), unit: "month" };

  return { value: -Math.floor(elapsed / 31_536_000), unit: "year" };
}

/** `relativeAge`, formatted. Separate so the bucketing can be tested without `Intl`. */
export function formatRelativeAge(at: string | Date, now: Date, locale: string): string {
  const { value, unit } = relativeAge(at, now);
  return new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(value, unit);
}
