import fp from "fastify-plugin";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { MembershipStatuses, type Actor, type TenantStatus } from "@bam/auth";
import { ErrorCodes, ForbiddenError, NotFoundError, UnauthenticatedError } from "@bam/contracts";

declare module "fastify" {
  interface FastifyRequest {
    /** The tenant this request operates on, once resolved. */
    tenant?: ResolvedTenant;
    /** Who is asking, with their membership in `tenant` if any. */
    actor?: Actor;
    /**
     * Resolve tenant + membership for this request.
     *
     * Idempotent, so guards can call it without coordinating. Throws rather
     * than returning undefined: every failure here is a real 401/403/404.
     */
    resolveTenantContext(): Promise<{ tenant: ResolvedTenant; actor: Actor }>;
  }
}

export interface ResolvedTenant {
  id: string;
  slug: string;
  name: string;
  status: TenantStatus;
  defaultTimezone: string;
  defaultLanguage: string;
}

/** Canonical way for a client to say which tenant it means. */
export const TENANT_HEADER = "x-tenant-id";

/**
 * Resolves the tenant for a request, and the actor's standing within it.
 *
 * ## The rule that matters
 *
 * A client-supplied tenant identifier is only ever a *hint*. It selects which
 * tenant to look up; it never asserts access. Access comes from an ACTIVE
 * membership row found server-side (tech-impl §7.2, §34.2).
 *
 * The predecessor project left this to each handler, hand-writing
 * `where: { organizationId }` — and several handlers simply forgot, so any
 * authenticated user of any tenant could read another tenant's departments and
 * providers by ID. Resolution happens here, once, or not at all.
 *
 * Order of precedence:
 *   1. `X-Tenant-Id` header — explicit, and what the dashboard sends.
 *   2. The session's `activeTenantId` — convenience for a plain browser visit.
 *
 * Both are validated identically. Neither is trusted.
 */
const tenantContextPlugin: FastifyPluginAsync = async (app) => {
  app.decorateRequest("tenant", undefined);
  app.decorateRequest("actor", undefined);
  app.decorateRequest("resolveTenantContext", null as never);

  app.addHook("onRequest", (request, _reply, done) => {
    request.resolveTenantContext = async () => {
      if (request.tenant && request.actor) {
        return { tenant: request.tenant, actor: request.actor };
      }

      const user = request.user;
      if (!user) {
        throw new UnauthenticatedError("Sign in to access tenant data.");
      }

      const tenantId = await resolveTenantId(request);
      if (!tenantId) {
        throw new ForbiddenError(
          `No tenant selected. Send the ${TENANT_HEADER} header, or sign in to a tenant.`,
        );
      }

      const tenant = await app.prisma.tenant.findUnique({
        where: { id: tenantId },
        select: {
          id: true,
          slug: true,
          name: true,
          status: true,
          defaultTimezone: true,
          defaultLanguage: true,
        },
      });

      // A tenant that exists but the caller cannot see must be indistinguishable
      // from one that does not exist, or the API becomes a tenant-enumeration
      // oracle. Both paths return the same 404.
      if (!tenant) {
        throw new NotFoundError("Tenant not found.", ErrorCodes.TENANT_NOT_FOUND);
      }

      const membership = await app.prisma.membership.findUnique({
        where: { tenantId_userId: { tenantId: tenant.id, userId: user.id } },
        select: { id: true, tenantId: true, role: true, status: true, providerId: true },
      });

      if (!membership && !user.isPlatformAdmin) {
        throw new NotFoundError("Tenant not found.", ErrorCodes.TENANT_NOT_FOUND);
      }

      const actor: Actor = {
        userId: user.id,
        isPlatformAdmin: user.isPlatformAdmin,
        ...(membership
          ? {
              membership: {
                id: membership.id,
                tenantId: membership.tenantId,
                role: membership.role,
                status: membership.status,
                providerId: membership.providerId ?? undefined,
              },
            }
          : {}),
      };

      // An invited-but-not-joined or suspended member is not a member yet.
      // Distinguished from "no membership" so the message can be useful.
      if (membership && membership.status !== MembershipStatuses.ACTIVE) {
        throw new ForbiddenError(
          membership.status === MembershipStatuses.INVITED
            ? "Accept your invitation before accessing this tenant."
            : "Your access to this tenant is suspended.",
        );
      }

      request.tenant = tenant;
      request.actor = actor;
      request.enrichContext({
        tenantId: tenant.id,
        ...(membership ? { membershipId: membership.id, role: membership.role } : {}),
      });

      return { tenant: request.tenant, actor };
    };

    done();
  });

  /** Header first, then whatever tenant the session was last working in. */
  async function resolveTenantId(request: FastifyRequest): Promise<string | undefined> {
    const header = request.headers[TENANT_HEADER];
    if (typeof header === "string" && header.length > 0) return header;

    const cookie = request.headers.cookie;
    if (!cookie || !request.user) return undefined;

    const session = await app.prisma.session.findFirst({
      where: { userId: request.user.id, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: "desc" },
      select: { activeTenantId: true },
    });

    return session?.activeTenantId ?? undefined;
  }
};

export default fp(tenantContextPlugin, {
  name: "tenant-context",
  dependencies: ["auth", "database", "request-context"],
});
