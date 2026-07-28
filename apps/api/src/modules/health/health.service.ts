import { checkDatabaseConnection, type PrismaClient } from "@bam/db";
import type { DependencyCheck, ReadinessResponse } from "@bam/contracts";

export interface HealthServiceDeps {
  prisma: PrismaClient;
  /** Undefined until Epic 5 wires Redis in. */
  redisUrl?: string | undefined;
  version: string;
  startedAt: number;
}

/**
 * Readiness logic, kept out of the route handler so it stays testable without
 * an HTTP layer (CLAUDE.md rule 8).
 */
export class HealthService {
  constructor(private readonly deps: HealthServiceDeps) {}

  uptimeSeconds(): number {
    return Math.round((Date.now() - this.deps.startedAt) / 1000);
  }

  async readiness(): Promise<ReadinessResponse> {
    const [postgres, redis] = await Promise.all([this.checkPostgres(), this.checkRedis()]);

    // `not_configured` is not a failure. Redis is optional until Epic 5, and
    // reporting an absent optional dependency as unhealthy is how real alerts
    // get ignored.
    const degraded = postgres.status === "down" || redis.status === "down";

    return {
      status: degraded ? "degraded" : "ok",
      uptimeSeconds: this.uptimeSeconds(),
      version: this.deps.version,
      checks: { postgres, redis },
    };
  }

  private async checkPostgres(): Promise<DependencyCheck> {
    const result = await checkDatabaseConnection(this.deps.prisma);

    if (result.ok) {
      return { status: "ok", latencyMs: result.latencyMs };
    }

    // Error *name* only. A driver error message can carry the connection
    // string, and this value is returned over HTTP (CLAUDE.md rule 6).
    return {
      status: "down",
      latencyMs: result.latencyMs,
      ...(result.error === undefined ? {} : { error: result.error }),
    };
  }

  private checkRedis(): Promise<DependencyCheck> {
    if (!this.deps.redisUrl) {
      return Promise.resolve({ status: "not_configured" });
    }

    // Epic 5 replaces this with a real PING once BullMQ lands.
    return Promise.resolve({ status: "ok" });
  }
}
