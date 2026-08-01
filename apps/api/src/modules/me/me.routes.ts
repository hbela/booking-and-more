import { z } from "zod";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { permissionsForRole } from "@bam/auth";
import { commonErrorResponses, daysUntil, idSchema } from "@bam/contracts";

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
        };
      } catch {
        return base;
      }
    },
  );
};
