/**
 * Does this signed-in user belong to no organization at all?
 *
 * A predicate rather than an inline `tenants.length === 0`, and in `lib/` for
 * the reason `dashboard-nav.ts` is: the interesting part is the case it
 * *refuses* to answer, and a rule nobody can see is a rule the next edit
 * removes.
 *
 * Every screen under `dashboard/` scopes its queries to `context.tenantId`.
 * With no tenant those queries never fire, so the screen renders its shell
 * around a body that stays empty — which reads as a hung request, and was
 * reported as one.
 *
 * ## Settled and empty, never merely empty
 *
 * The list is also empty while the request is in flight, and — the case that
 * matters — when it failed. Announcing "you belong to no organization" because
 * the API did not answer is a confident lie, and worse than the blank screen it
 * replaces: it sends somebody to ask for an invitation they already have. So
 * this answers true only once the query has actually succeeded and come back
 * with nothing. Every other state is somebody else's to render.
 *
 * A platform admin is permanently in this state by design — they hold no
 * memberships (CLAUDE.md rule 9) and `canHoldTenantMembership` refuses to let
 * them acquire one — which is why the caller still has to ask *who* is looking
 * before deciding what to say.
 */
export function hasNoOrganization(tenants: { settled: boolean; count: number }): boolean {
  return tenants.settled && tenants.count === 0;
}
