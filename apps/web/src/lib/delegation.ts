import type { DelegationScope, MeResponse } from "./api-client";

/**
 * Which diaries the signed-in member may work on, and why.
 *
 * Pure, so it can be unit-tested without a DOM or a query client — the same
 * reason `member-diary.ts` next door is. It is also the one place the
 * three-way answer is computed: an administrator sees every diary, a provider
 * sees their own, a delegate sees the ones handed to them, and any of the three
 * can be combined (a provider who is also delegated a colleague's diary is a
 * state the model allows).
 *
 * Advisory only. The API re-decides on every request; this decides what to
 * render. docs/phase-3-4-diary-delegation.md §6.2.
 */
export interface DiaryScope {
  /** True when the caller holds the `:all` permission and the list is unbounded. */
  everyDiary: boolean;
  /**
   * The specific diaries reachable when `everyDiary` is false. Empty means
   * exactly that — nothing — and must never be rendered as "all".
   */
  providerIds: string[];
  /** The caller's own diary, if their membership names one. */
  ownProviderId: string | null;
}

/**
 * @param me the `/v1/me` payload
 * @param permissionAll the `:all` permission for the thing being scoped
 * @param scope the delegation scope that covers it
 */
export function diaryScopeFor(
  me: MeResponse | null | undefined,
  permissionAll: string,
  scope: DelegationScope,
): DiaryScope {
  const ownProviderId = me?.membership?.providerId ?? null;

  if (me?.permissions.includes(permissionAll) === true) {
    return { everyDiary: true, providerIds: [], ownProviderId };
  }

  const ids = new Set<string>();
  if (ownProviderId !== null) ids.add(ownProviderId);

  for (const delegation of me?.delegations ?? []) {
    if (delegation.scopes.includes(scope)) ids.add(delegation.providerId);
  }

  return { everyDiary: false, providerIds: [...ids], ownProviderId };
}

/**
 * Does this member reach any diary at all for `scope`?
 *
 * True for an administrator, who reaches every diary. Use this where the screen
 * is genuinely organization-wide — the bookings list is — and
 * {@link hasPersonalDiary} where it belongs to one provider.
 *
 * The point of asking at all is that since delegation a permission no longer
 * implies a diary: `booking:read:delegated` is held by every ASSISTANT from the
 * moment they join, and authorises nothing until somebody grants them one.
 */
export function hasAnyDiary(scope: DiaryScope): boolean {
  return scope.everyDiary || scope.providerIds.length > 0;
}

/**
 * Does this member have a diary of their *own* to reach — theirs, or one handed
 * to them?
 *
 * Deliberately **false for an administrator**, even though they may edit every
 * diary in the organization. That is what decides the top-level Availability
 * nav item, and phase-2-3 §2.7 is explicit: availability belongs to a provider,
 * not to the organization, so an owner reaches one diary at a time from the row
 * on Providers. A top-level entry would imply the owner fills it in, which is
 * the opposite of who decides.
 *
 * Reading `:all` as "has a diary" would quietly undo that, which is why this is
 * a named function rather than `everyDiary || providerIds.length > 0`.
 */
export function hasPersonalDiary(
  me: MeResponse | null | undefined,
  scope: DelegationScope,
): boolean {
  if ((me?.membership?.providerId ?? null) !== null) return true;
  return (me?.delegations ?? []).some((delegation) => delegation.scopes.includes(scope));
}
