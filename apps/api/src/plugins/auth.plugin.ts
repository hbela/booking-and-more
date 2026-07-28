import fp from "fastify-plugin";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { createAuth, type Auth } from "@bam/auth";

declare module "fastify" {
  interface FastifyInstance {
    auth: Auth;
  }
  interface FastifyRequest {
    /** The signed-in user, or undefined. Resolved once per request. */
    user?: AuthenticatedUser;
  }
}

export interface AuthenticatedUser {
  id: string;
  email: string;
  name: string;
  isPlatformAdmin: boolean;
}

export interface AuthPluginOptions {
  secret: string;
  baseUrl: string;
  appUrl: string;
  secureCookies: boolean;
  google?: { clientId: string; clientSecret: string } | undefined;
}

/**
 * Mounts Better Auth and resolves the session.
 *
 * Two responsibilities, deliberately kept apart from authorization:
 *
 *  1. Expose Better Auth's own routes under `/v1/auth/*` by bridging Fastify's
 *     Node request/response to the Fetch API that Better Auth speaks.
 *  2. Resolve the session **once** per request in an `onRequest` hook and
 *     decorate `request.user`.
 *
 * Resolving once matters: without it every guard and handler that wants to know
 * who is asking triggers its own session lookup. The predecessor project's
 * cleanest auth implementation (appointer-console) did exactly this, and it is
 * the pattern worth carrying forward.
 *
 * This plugin answers "who are you". It never answers "may you" — that is
 * authorization.plugin.ts, working from the actor this one resolved.
 */
const authPlugin: FastifyPluginAsync<AuthPluginOptions> = async (app, options) => {
  const auth = createAuth({
    prisma: app.prisma,
    secret: options.secret,
    baseUrl: options.baseUrl,
    appUrl: options.appUrl,
    secureCookies: options.secureCookies,
    google: options.google,
  });

  app.decorate("auth", auth);
  app.decorateRequest("user", undefined);

  // --- Better Auth's own routes --------------------------------------------
  // Sign-up, sign-in, sign-out, callbacks, session. Better Auth owns the
  // handler; we only translate between Node and Fetch.
  //
  // The body is passed through untouched: Better Auth validates it, and parsing
  // it here would consume the stream before it gets there.
  app.route({
    method: ["GET", "POST"],
    url: "/v1/auth/*",
    // Better Auth validates its own payloads, so a Zod schema here would be a
    // second, divergent source of truth. Documented as an exception to
    // CLAUDE.md rule 2 rather than left as a silent gap.
    schema: { hide: true },
    config: {
      // Sign-in and password reset need a stricter limit than the global one
      // (tech-impl §33). A per-route limit replaces the global for this route.
      rateLimit: { max: 20, timeWindow: "1 minute" },
    },
    async handler(request, reply) {
      const url = new URL(request.url, options.baseUrl);

      const headers = new Headers();
      for (const [key, value] of Object.entries(request.headers)) {
        if (value === undefined) continue;
        if (Array.isArray(value)) {
          for (const entry of value) headers.append(key, entry);
        } else {
          headers.append(key, value);
        }
      }

      const response = await auth.handler(
        new Request(url.toString(), {
          method: request.method,
          headers,
          ...(request.method === "GET" || request.method === "HEAD"
            ? {}
            : { body: JSON.stringify(request.body ?? {}) }),
        }),
      );

      void reply.status(response.status);
      response.headers.forEach((value, key) => {
        // set-cookie must be appended, not set: a sign-in emits several and
        // Headers collapses them into one comma-joined value otherwise.
        if (key.toLowerCase() === "set-cookie") {
          void reply.header("set-cookie", value);
        } else {
          void reply.header(key, value);
        }
      });

      return reply.send(response.body ? await response.text() : null);
    },
  });

  // --- Session resolution ---------------------------------------------------
  app.addHook("onRequest", async (request) => {
    const session = await resolveSession(auth, request);
    if (!session) return;

    request.user = session;

    // Feed identity into the log/audit/Sentry context established in Phase 0.
    request.enrichContext({ userId: session.id });
  });
};

async function resolveSession(
  auth: Auth,
  request: FastifyRequest,
): Promise<AuthenticatedUser | undefined> {
  const cookie = request.headers.cookie;
  if (!cookie) return undefined;

  try {
    const session = await auth.api.getSession({ headers: new Headers({ cookie }) });
    if (!session?.user) return undefined;

    return {
      id: session.user.id,
      email: session.user.email,
      name: session.user.name,
      // Present because of the additionalFields declaration in @bam/auth.
      isPlatformAdmin: session.user.isPlatformAdmin === true,
    };
  } catch (error) {
    // An unreadable or expired cookie means "not signed in", not "500". Logged
    // at debug because a stale cookie after a secret rotation is routine and
    // would otherwise flood the error log.
    request.log.debug({ err: error }, "session resolution failed");
    return undefined;
  }
}

export default fp(authPlugin, { name: "auth", dependencies: ["database", "request-context"] });
