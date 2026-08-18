import { z } from "zod";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import {
  ALL_DELEGATION_SCOPES,
  DELEGATION_SCOPE_PERMISSIONS,
  permissionsForRole,
  type DelegatedProviderIds,
} from "@bam/auth";
import { ErrorCodes, commonErrorResponses, daysUntil, idSchema, isAppError } from "@bam/contracts";

/**
 * Invert the actor's permission-indexed grant set back into one row per diary.
 *
 * The Actor carries `permission -> providerIds` because that is the shape
 * `canForProvider` wants (docs/phase-3-4-diary-delegation.md §2.4); a screen
 * wants `providerId -> scopes`. Inverting here is cheaper than a second query
 * and, more usefully, guarantees the answer matches what the guards will decide
 * on the next request — a query could disagree with the memoised actor.
 */
function delegationsOf(
  delegated: DelegatedProviderIds | undefined,
): { providerId: string; scopes: string[] }[] {
  if (!delegated) return [];

  const byProvider = new Map<string, Set<string>>();

  for (const scope of ALL_DELEGATION_SCOPES) {
    // A scope is present for a diary when *every* permission it confers is —
    // they are written together, so an intersection and a union agree, and the
    // intersection is the one that cannot over-report.
    const permissions = DELEGATION_SCOPE_PERMISSIONS[scope];
    const idSets = permissions.map((permission) => new Set(delegated[permission] ?? []));
    const first = idSets[0];
    if (!first) continue;

    for (const providerId of first) {
      if (!idSets.every((ids) => ids.has(providerId))) continue;
      const scopes = byProvider.get(providerId) ?? new Set<string>();
      scopes.add(scope);
      byProvider.set(providerId, scopes);
    }
  }

  return [...byProvider].map(([providerId, scopes]) => ({ providerId, scopes: [...scopes] }));
}

/**
 * Who am I, and what may I do here?
 *
 * One call the web app makes on load, so the UI can hide controls the caller
 * cannot use. The permission list is derived server-side from the same table
 * the guards use, so the UI and the API can never disagree about what is
 * allowed — the client is just reading the answer, not computing its own.
 */
export const meRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    "",
    {
      preHandler: [app.requireAuth],
      schema: {
        tags: ["me"],
        summary: "The signed-in user, and their standing in the selected tenant",
        description:
          "Tenant fields are present only when an X-Tenant-Id header (or an active session tenant) resolves to a membership.",
        response: {
          200: z.object({
            user: z.object({
              id: idSchema,
              name: z.string(),
              email: z.email(),
              isPlatformAdmin: z.boolean(),
            }),
            tenant: z
              .object({
                id: idSchema,
                slug: z.string(),
                name: z.string(),
                status: z.enum(["PENDING_SUBSCRIPTION", "TRIAL", "ACTIVE", "SUSPENDED", "CLOSED"]),
                defaultTimezone: z.string(),
                defaultLanguage: z.string(),
                /** When this organization must have subscribed by. Null for an
                 *  internal one, which has no deadline (phase-9 §2.2). */
                subscribeBy: z.iso.datetime({ offset: true }).nullable(),
                /** Floored at zero; null when there is no deadline at all —
                 *  which is not the same as none left, so the pending panel
                 *  renders no countdown rather than "0 days". */
                daysRemaining: z.number().int().nullable(),
              })
              .nullable(),
            membership: z
              .object({
                id: idSchema,
                role: z.enum(["OWNER", "ADMIN", "PROVIDER", "ASSISTANT", "CUSTOMER"]),
                providerId: z.string().nullable(),
              })
              .nullable(),
            /** Effective permissions in the selected tenant. Advisory for the UI. */
            permissions: z.array(z.string()),
            /**
             * Diaries handed to this membership, and what each grant covers
             * (docs/phase-3-4-diary-delegation.md §5.3).
             *
             * Read straight off the resolved actor rather than queried again, so
             * it cannot disagree with what the guards will decide on the very
             * next request. The web app's only source of "which diaries may I
             * pick"; `GET /v1/me/delegations` is the richer version, with names.
             */
            delegations: z.array(z.object({ providerId: idSchema, scopes: z.array(z.string()) })),
          }),
          ...commonErrorResponses,
        },
      },
    },
    async (request) => {
      const user = request.user!;

      const base = {
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          isPlatformAdmin: user.isPlatformAdmin,
        },
        tenant: null,
        membership: null,
        permissions: [] as string[],
        delegations: [] as { providerId: string; scopes: string[] }[],
      };

      // No tenant selected is a normal state — a user who has just signed up
      // and has no tenants yet, for instance. Not an error.
      try {
        const { tenant, actor } = await request.resolveTenantContext();
        const membership = actor.membership;

        return {
          ...base,
          tenant: {
            id: tenant.id,
            slug: tenant.slug,
            name: tenant.name,
            status: tenant.status,
            defaultTimezone: tenant.defaultTimezone,
            defaultLanguage: tenant.defaultLanguage,
            subscribeBy: tenant.subscribeBy?.toISOString() ?? null,
            daysRemaining: daysUntil(tenant.subscribeBy),
          },
          membership: membership
            ? {
                id: membership.id,
                role: membership.role,
                providerId: membership.providerId ?? null,
              }
            : null,
          permissions: membership ? [...permissionsForRole(membership.role)] : [],
          delegations: delegationsOf(membership?.delegated),
        };
      } catch (error) {
        // An absent or ambiguous tenant selection is the one expected empty
        // state. A missing membership, a suspended membership, a database
        // outage, or a programming error must retain its real 4xx/5xx signal.
        if (isAppError(error) && error.code === ErrorCodes.TENANT_NOT_SELECTED) {
          return base;
        }
        throw error;
      }
    },
  );
};
