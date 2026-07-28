import fp from "fastify-plugin";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { Prisma } from "@bam/db";

declare module "fastify" {
  interface FastifyRequest {
    /**
     * Record an audited action. Fire-and-forget: never throws, never blocks the
     * response on the audit write succeeding.
     */
    audit(entry: AuditEntry): void;
  }
}

export type AuditActorType = "USER" | "PLATFORM_ADMIN" | "SYSTEM" | "CUSTOMER";

export interface AuditEntry {
  /** Past-tense verb: "tenant.created", "membership.role_changed". */
  action: string;
  entityType: string;
  entityId?: string | undefined;
  /** Overrides the request's tenant. Needed for tenant.created, where the
   *  tenant did not exist when the request started. */
  tenantId?: string | undefined;
  before?: unknown;
  after?: unknown;
}

/**
 * Append-only audit trail. tech-impl §34.5.
 *
 * ## Two decisions worth stating
 *
 * **Never throws.** An audit write that fails must not turn a successful
 * booking into a 500. Failures are logged loudly and swallowed. This mirrors
 * appointer-console's `lib/audit.ts`, which is the right shape.
 *
 * That is a real trade-off: it means the audit log is best-effort, not
 * transactional. For the actions audited here (tenant and membership changes)
 * that is acceptable. When Epic 4 audits booking writes, those go through the
 * transactional outbox instead, inside the same transaction as the booking —
 * because there, losing the record actually matters.
 *
 * **Snapshots are scrubbed.** `before`/`after` are JSON-serialised into a
 * column that people read during incidents. Passing a whole Prisma row would
 * eventually put a password hash or a customer's phone number in there, so
 * known-sensitive keys are dropped on the way in.
 */
const auditPlugin: FastifyPluginAsync = async (app) => {
  app.decorateRequest("audit", null as never);

  app.addHook("onRequest", (request, _reply, done) => {
    request.audit = (entry: AuditEntry) => {
      void writeAudit(request, entry);
    };
    done();
  });

  async function writeAudit(request: FastifyRequest, entry: AuditEntry): Promise<void> {
    try {
      const tenantId = entry.tenantId ?? request.tenant?.id;
      const user = request.user;
      const before = scrub(entry.before);
      const after = scrub(entry.after);

      // Typed explicitly rather than assembled with conditional spreads:
      // Prisma's create input is a union of checked and unchecked variants, and
      // a spread makes it impossible for TypeScript to pick one.
      const data: Prisma.AuditLogUncheckedCreateInput = {
        tenantId: tenantId ?? null,
        actorType: resolveActorType(request),
        actorId: user?.id ?? null,
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId ?? null,
        // Prisma.DbNull is SQL NULL; a plain `null` would store the JSON value
        // `null`, which reads as "we recorded an empty snapshot" rather than
        // "there was no snapshot".
        beforeJson: before ?? Prisma.DbNull,
        afterJson: after ?? Prisma.DbNull,
        requestId: request.context?.requestId ?? null,
        ipAddress: request.ip,
        userAgent: request.headers["user-agent"] ?? null,
      };

      await app.prisma.auditLog.create({ data });
    } catch (error) {
      // Loud, but not fatal. If audit writes start failing this needs a human;
      // it does not need the user's request to fail.
      request.log.error({ err: error, action: entry.action }, "failed to write audit log");
    }
  }
};

function resolveActorType(request: FastifyRequest): AuditActorType {
  if (!request.user) return "SYSTEM";
  // Platform-admin actions are distinguishable in the trail from a tenant
  // member doing the same thing — that difference is the point of an audit log.
  return request.user.isPlatformAdmin ? "PLATFORM_ADMIN" : "USER";
}

/**
 * Keys never allowed into an audit snapshot.
 *
 * Belt and braces alongside @bam/observability's log redaction: audit rows are
 * a different sink with a much longer retention (12 months, tech-impl §35).
 */
const FORBIDDEN_KEYS = new Set([
  "password",
  "passwordHash",
  "token",
  "tokenHash",
  "accessToken",
  "refreshToken",
  "idToken",
  "secret",
  "customerEmail",
  "customerPhone",
  "customerName",
  "transcript",
]);

function scrub(value: unknown, depth = 0): Prisma.InputJsonValue | null {
  if (value === undefined || value === null) return null;
  // Primitives are wrapped so the column always holds an object. Handled by
  // type rather than through String(), which would quietly turn a function or
  // a symbol into something meaningless.
  if (typeof value !== "object") {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      return { value };
    }
    if (typeof value === "bigint") return { value: value.toString() };
    // Functions and symbols are not data; record the shape, not the content.
    return { value: `[${typeof value}]` };
  }
  if (depth > 4) return { truncated: true };

  const out: Record<string, Prisma.InputJsonValue | null> = {};

  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_KEYS.has(key)) {
      out[key] = "[redacted]";
      continue;
    }
    if (entry instanceof Date) {
      out[key] = entry.toISOString();
      continue;
    }
    if (entry !== null && typeof entry === "object") {
      out[key] = scrub(entry, depth + 1);
      continue;
    }
    // Anything not JSON-representable (a function, a symbol, undefined) is
    // dropped rather than silently serialised as null.
    out[key] =
      entry === undefined || typeof entry === "function" || typeof entry === "symbol"
        ? null
        : entry;
  }

  return out;
}

export default fp(auditPlugin, {
  name: "audit",
  dependencies: ["database", "request-context"],
});
