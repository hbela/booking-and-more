import { randomUUID } from "node:crypto";
import fp from "fastify-plugin";
import type { FastifyPluginAsync } from "fastify";
import { enrichRequestContext, runWithRequestContext } from "@bam/observability";
import type { RequestContext } from "@bam/observability";

declare module "fastify" {
  interface FastifyRequest {
    /** Per-request identity and correlation fields. tech-impl §7.1. */
    context: RequestContext;
    /** Merge fields in once authentication or tenant resolution has run. */
    enrichContext(fields: Partial<RequestContext>): void;
  }
}

const HEADER = "x-request-id";

/** Conservative: this value reaches the logs, so it must not be a log-injection vector. */
const SAFE_REQUEST_ID = /^[\w-]{1,128}$/;

/**
 * Establishes the per-request context and binds it to AsyncLocalStorage, so
 * every log line, audit event and Sentry report carries `requestId` (and later
 * `tenantId` / `userId`) without being threaded through call signatures.
 *
 * tech-impl §7.1.
 */
const requestContextPlugin: FastifyPluginAsync = async (app) => {
  // Declared up front so every request object keeps the same hidden class;
  // the real values are assigned in the hook below.
  app.decorateRequest("context", null as unknown as RequestContext);
  app.decorateRequest(
    "enrichContext",
    null as unknown as (fields: Partial<RequestContext>) => void,
  );

  app.addHook("onRequest", (request, reply, done) => {
    // Honour an inbound request ID so a trace survives the proxy hop.
    const inbound = request.headers[HEADER];
    const requestId =
      typeof inbound === "string" && SAFE_REQUEST_ID.test(inbound)
        ? inbound
        : `req_${randomUUID()}`;

    const context: RequestContext = { requestId };

    request.context = context;
    request.enrichContext = (fields: Partial<RequestContext>) => {
      Object.assign(context, fields);
      enrichRequestContext(fields);
    };

    // Echo it back so a caller can quote it in a bug report.
    void reply.header(HEADER, requestId);

    // Bind the context onto the request logger, so Fastify's own request and
    // response lines carry it too — not just explicit log calls.
    request.log = request.log.child({ requestId });

    // Bind for the remainder of the request's async tree.
    runWithRequestContext(context, done);
  });
};

export default fp(requestContextPlugin, { name: "request-context" });
