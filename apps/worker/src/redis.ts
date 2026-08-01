import { Redis } from "ioredis";
import type { Logger } from "@bam/observability";

/**
 * The worker's Redis connection.
 *
 * Constructed lazily and shared (CLAUDE.md rule 4): a missing REDIS_URL must
 * degrade queue processing and nothing else, and the worker has to be able to
 * start, say it has no queues, and stay up.
 *
 * ## Why one connection, deliberately shared
 *
 * BullMQ opens its own connection per Queue and two per Worker unless handed
 * one. Seven queues (tech-impl §26) reaches twenty-odd connections without
 * anybody deciding to, and hosted Redis plans cap connections well before they
 * cap memory — the free tiers at thirty. Passing this instance in everywhere
 * keeps that arithmetic ours rather than emergent.
 */

export interface RedisConnectionOptions {
  url: string;
  logger: Logger;
}

/**
 * BullMQ requires `maxRetriesPerRequest: null`.
 *
 * ioredis defaults to 20, after which a command rejects. BullMQ's workers sit
 * in blocking reads (`BZPOPMIN`) that legitimately outlive any retry budget, so
 * the default turns an ordinary idle period into a stream of errors. BullMQ
 * throws at construction if this is set to anything else, which is the library
 * being helpful — the failure it prevents is subtle and intermittent.
 */
const BULLMQ_REQUIRED_OPTIONS = {
  maxRetriesPerRequest: null,
} as const;

let connection: Redis | undefined;

export function getRedis(options: RedisConnectionOptions): Redis {
  if (connection !== undefined) return connection;

  const client = new Redis(options.url, {
    ...BULLMQ_REQUIRED_OPTIONS,
    // Queue work is not latency-critical, and a burst of reconnects against a
    // provider that is already struggling makes things worse. Back off.
    retryStrategy: (attempt) => Math.min(attempt * 500, 10_000),
    // Fail fast at startup rather than queueing commands against a connection
    // that may never open — a worker that cannot reach Redis should say so.
    enableOfflineQueue: false,
    lazyConnect: false,
  });

  client.on("error", (error: Error) => {
    // Never log the URL: it carries credentials (CLAUDE.md rule 6).
    options.logger.error({ err: error }, "redis: connection error");
  });

  client.on("ready", () => {
    options.logger.info("redis: connected");
  });

  connection = client;
  return client;
}

/**
 * Resolve once the connection can carry commands.
 *
 * `enableOfflineQueue: false` means a command issued before the socket is up
 * rejects immediately rather than waiting. That is the behaviour we want at
 * runtime — a worker that cannot reach Redis should say so rather than buffer
 * silently — but it makes any startup check race the connection, and a check
 * that always fails is worse than no check because it reports "unavailable"
 * rather than "not run".
 */
export async function waitForReady(client: Redis, timeoutMs = 10_000): Promise<boolean> {
  if (client.status === "ready") return true;

  return new Promise<boolean>((resolve) => {
    const settle = (ready: boolean): void => {
      clearTimeout(timer);
      client.off("ready", onReady);
      client.off("error", onError);
      resolve(ready);
    };

    const onReady = (): void => {
      settle(true);
    };
    const onError = (): void => {
      settle(false);
    };

    const timer = setTimeout(() => {
      settle(false);
    }, timeoutMs);

    client.once("ready", onReady);
    client.once("error", onError);
  });
}

/**
 * Verify the server is configured in a way BullMQ can rely on.
 *
 * An eviction policy other than `noeviction` lets Redis delete job keys under
 * memory pressure — mid-Lua-script, between a job's hash and the sorted set
 * that references it. The result is not a lost job so much as a corrupted
 * queue, and it happens precisely when the system is busiest.
 *
 * Reported rather than thrown: a misconfigured Redis is worth shouting about,
 * but refusing to start leaves the outbox undrained, which is worse.
 */
export async function checkEvictionPolicy(
  client: Redis,
  logger: Logger,
): Promise<{ ok: boolean; policy?: string }> {
  try {
    const result = await client.config("GET", "maxmemory-policy");
    // Redis replies as a flat [name, value] array.
    const policy = Array.isArray(result) ? String(result[1] ?? "") : "";

    if (policy === "") {
      logger.warn("redis: could not read maxmemory-policy; skipping eviction check");
      return { ok: true };
    }

    if (policy !== "noeviction") {
      logger.error(
        { policy },
        "redis: maxmemory-policy must be 'noeviction' for BullMQ — jobs can be evicted mid-flight under memory pressure",
      );
      return { ok: false, policy };
    }

    return { ok: true, policy };
  } catch (error) {
    // Hosted Redis often forbids CONFIG GET. Not knowing is not a failure.
    logger.debug({ err: error }, "redis: eviction policy check unavailable");
    return { ok: true };
  }
}

/** Close the shared connection. Idempotent, so shutdown paths can be dumb. */
export async function closeRedis(): Promise<void> {
  if (connection === undefined) return;

  const client = connection;
  connection = undefined;
  await client.quit();
}
