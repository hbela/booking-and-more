import fp from "fastify-plugin";
import type { FastifyPluginAsync, preHandlerAsyncHookHandler } from "fastify";
import { can, tenantAcceptsWrites, type Permission } from "@bam/auth";
import { ForbiddenError, UnauthenticatedError } from "@bam/contracts";

declare module "fastify" {
  interface FastifyInstance {
    /** 401 unless a session resolved. */
    requireAuth: preHandlerAsyncHookHandler;
    /** Resolve tenant + membership, then assert the permission. */
    requirePermission(permission: Permission): preHandlerAsyncHookHandler;
    /** Resolve tenant + membership without asserting any specific permission. */
    requireTenant: preHandlerAsyncHookHandler;
    /** Reject writes to a suspended or closed tenant. */
    requireWritableTenant: preHandlerAsyncHookHandler;
    /** Platform operators only. */
    requirePlatformAdmin: preHandlerAsyncHookHandler;
  }
}

/**
 * Route guards, expressed as permissions rather than roles.
 *
 * Handlers declare what a request needs to *do* — `requirePermission(
 * Permissions.MEMBER_MANAGE)` — never which role the caller must hold. Adding
 * or re-scoping a role then means editing one table in @bam/auth, not auditing
 * every route (tech-impl §8.4).
 *
 * All decisions delegate to the pure functions in @bam/auth/policy, so the rules
 * are unit-tested independently of HTTP.
 */
const authorizationPlugin: FastifyPluginAsync = async (app) => {
  const requireAuth: preHandlerAsyncHookHandler = (request) => {
    if (!request.user) {
      throw new UnauthenticatedError();
    }
    return Promise.resolve();
  };

  const requireTenant: preHandlerAsyncHookHandler = async (request) => {
    await request.resolveTenantContext();
  };

  const requireWritableTenant: preHandlerAsyncHookHandler = async (request) => {
    const { tenant } = await request.resolveTenantContext();

    // Checked before any permission: a suspended tenant must reject even its
    // owner's writes, while reads stay available so people can still see their
    // data and settle an invoice (Epic 9).
    if (!tenantAcceptsWrites(tenant.status)) {
      throw new ForbiddenError(
        `This account is ${tenant.status.toLowerCase()} and cannot accept changes.`,
      );
    }
  };

  const requirePlatformAdmin: preHandlerAsyncHookHandler = (request) => {
    if (!request.user) throw new UnauthenticatedError();

    // Same 403 whether or not the caller is signed in as someone ordinary —
    // there is nothing to learn from the difference.
    if (!request.user.isPlatformAdmin) {
      throw new ForbiddenError("Platform administrator access is required.");
    }
    return Promise.resolve();
  };

  app.decorate("requireAuth", requireAuth);
  app.decorate("requireTenant", requireTenant);
  app.decorate("requireWritableTenant", requireWritableTenant);
  app.decorate("requirePlatformAdmin", requirePlatformAdmin);

  app.decorate("requirePermission", (permission: Permission): preHandlerAsyncHookHandler => {
    return async (request) => {
      const { tenant, actor } = await request.resolveTenantContext();

      if (!can(actor, tenant.id, permission)) {
        // Deliberately does not name the missing permission: that would tell an
        // attacker which capability to go looking for.
        throw new ForbiddenError("You do not have permission to perform this action.");
      }
    };
  });
};

export default fp(authorizationPlugin, {
  name: "authorization",
  dependencies: ["tenant-context"],
});
