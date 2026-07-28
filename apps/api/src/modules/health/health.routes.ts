import { z } from "zod";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import {
  errorEnvelopeSchema,
  livenessResponseSchema,
  readinessResponseSchema,
} from "@bam/contracts";
import { HealthService } from "./health.service.js";

export interface HealthRoutesOptions {
  redisUrl?: string | undefined;
  version: string;
  startedAt: number;
}

/**
 * Health routes. tech-impl §41.2.
 *
 * Every route here declares a full `schema`, including responses — this module
 * is the template the rest of the API copies (CLAUDE.md rule 2).
 */
export const healthRoutes: FastifyPluginAsyncZod<HealthRoutesOptions> = async (app, options) => {
  const service = new HealthService({
    prisma: app.prisma,
    redisUrl: options.redisUrl,
    version: options.version,
    startedAt: options.startedAt,
  });

  app.get(
    "/live",
    {
      // Liveness must never be rate limited: throttling it makes an orchestrator
      // conclude the process is dead and restart a healthy service.
      config: { rateLimit: false },
      schema: {
        tags: ["health"],
        summary: "Liveness probe",
        description:
          "Reports only that the process is running. Touches no dependency, so a slow database cannot trigger a restart loop.",
        response: { 200: livenessResponseSchema },
      },
    },
    () => ({ status: "ok" as const, uptimeSeconds: service.uptimeSeconds() }),
  );

  app.get(
    "/ready",
    {
      config: { rateLimit: false },
      schema: {
        tags: ["health"],
        summary: "Readiness probe",
        description:
          "Reports whether the service can serve traffic. Returns 503 when a required dependency is down, so a load balancer can drain this instance.",
        response: {
          200: readinessResponseSchema,
          503: readinessResponseSchema,
        },
      },
    },
    async (_request, reply) => {
      const result = await service.readiness();
      // A degraded service must not answer 200 — that is the difference between
      // a probe that works and one that is decorative.
      return reply.status(result.status === "ok" ? 200 : 503).send(result);
    },
  );

  /**
   * Exists to prove the error contract end to end, and is asserted in the test
   * suite. It is not a debug endpoint: it takes no action, exposes no state,
   * and is documented in the OpenAPI spec (CLAUDE.md rule 7).
   */
  app.post(
    "/echo",
    {
      schema: {
        tags: ["health"],
        summary: "Contract probe",
        description:
          "Echoes a validated payload. Verifies that request validation, response serialization and the error envelope all agree.",
        body: z.object({
          message: z.string().min(1).max(280),
        }),
        response: {
          200: z.object({ message: z.string(), requestId: z.string() }),
          422: errorEnvelopeSchema,
        },
      },
    },
    (request) => ({
      message: request.body.message,
      requestId: request.context.requestId,
    }),
  );
};
