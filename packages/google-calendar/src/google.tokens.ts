/**
 * When a stored access token has to be replaced before it is used.
 * docs/phase-6-google-calendar-part-1.md §2.9.
 *
 * A Google access token lasts an hour; the refresh token that mints new ones
 * lasts until somebody revokes it. **Two processes need this decision** — the
 * API when a provider opens the calendar picker, and the worker on every sync —
 * so the rule lives here rather than being written twice with two different
 * safety margins.
 *
 * Only the *decision* is shared. Refreshing itself stays with each caller,
 * because refreshing means persisting a newly sealed token and only the caller
 * has a database (see the note at the top of `google.calendar.ts`).
 */

/**
 * How long before expiry a token counts as already expired.
 *
 * Five minutes, and generous on purpose. The alternative failure is a 401 in the
 * middle of a batch of calendar writes, which costs a retry cycle and an alarming
 * log line to save one refresh call — and refreshes are cheap and unmetered.
 * It also absorbs clock skew between us and Google, which is the thing that makes
 * a zero-margin check fail intermittently and unreproducibly.
 */
export const ACCESS_TOKEN_SKEW_MS = 5 * 60 * 1_000;

/**
 * `null` counts as stale, deliberately.
 *
 * A row with an access token and no expiry is a row we cannot reason about, and
 * the safe reading of "I do not know when this expires" is "assume it has".
 * Refreshing costs one request; guessing wrong costs a failed write.
 */
export function isAccessTokenStale(
  expiresAt: Date | null | undefined,
  now: Date,
  skewMs: number = ACCESS_TOKEN_SKEW_MS,
): boolean {
  if (expiresAt === null || expiresAt === undefined) return true;

  return expiresAt.getTime() - now.getTime() <= skewMs;
}
