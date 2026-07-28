import { z } from "zod";

/**
 * Health contract. tech-impl §41.2.
 *
 * `live`  — the process is running. Used by the container healthcheck and by
 *           orchestrators deciding whether to restart. Must never touch a
 *           dependency: a slow database would otherwise cause a restart loop.
 * `ready` — the process can serve traffic. Checks dependencies, and is what a
 *           load balancer should gate on.
 */

export const livenessResponseSchema = z.object({
  status: z.literal("ok"),
  uptimeSeconds: z.number(),
});
export type LivenessResponse = z.infer<typeof livenessResponseSchema>;

/**
 * `not_configured` is deliberately distinct from `down`. Redis is optional until
 * Epic 5, and an absent optional dependency must not make the service look
 * unhealthy — that ambiguity is how real outages get ignored.
 */
export const dependencyStatusSchema = z.enum(["ok", "down", "not_configured"]);
export type DependencyStatus = z.infer<typeof dependencyStatusSchema>;

export const dependencyCheckSchema = z.object({
  status: dependencyStatusSchema,
  latencyMs: z.number().optional(),
  /** Short, non-sensitive reason. Never a connection string or driver dump. */
  error: z.string().optional(),
});
export type DependencyCheck = z.infer<typeof dependencyCheckSchema>;

export const readinessResponseSchema = z.object({
  status: z.enum(["ok", "degraded"]),
  uptimeSeconds: z.number(),
  version: z.string(),
  checks: z.object({
    postgres: dependencyCheckSchema,
    redis: dependencyCheckSchema,
  }),
});
export type ReadinessResponse = z.infer<typeof readinessResponseSchema>;
