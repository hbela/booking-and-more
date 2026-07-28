import { AsyncLocalStorage } from "node:async_hooks";
import type { LogContext } from "./logger.js";

/**
 * Ambient per-request context. tech-impl §7.1.
 *
 * Exists so logs, audit events and Sentry scopes automatically carry
 * `requestId` / `tenantId` / `userId` without every function signature growing a
 * context parameter.
 *
 * It is a read-mostly convenience, not an authorization mechanism: never derive
 * a permission decision from `getRequestContext().tenantId`. Tenant scoping is
 * an explicit, required argument on every repository call (CLAUDE.md rule 5).
 */
export interface RequestContext extends LogContext {
  requestId: string;
  membershipId?: string;
  role?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

/** Run `fn` with `context` bound for the whole async call tree. */
export function runWithRequestContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

export function getRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

/**
 * Merge fields into the active context. Used once identity is resolved — the
 * request starts with only a `requestId`, and gains `tenantId` / `userId` after
 * authentication runs.
 *
 * A no-op outside a request, which is the correct behaviour for worker jobs.
 */
export function enrichRequestContext(fields: Partial<RequestContext>): void {
  const current = storage.getStore();
  if (!current) return;
  Object.assign(current, fields);
}
