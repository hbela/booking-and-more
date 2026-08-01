import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/prisma/client.js";

export * from "./generated/prisma/client.js";
export { PrismaClient };

/**
 * Process-wide Prisma client.
 *
 * Deliberately plain. The predecessor project's equivalent grew to ~190 lines of
 * env-file precedence heuristics, Accelerate-URL sniffing and a `$extends` query
 * hook that rewrote enum casing — all of it treating symptoms of problems fixed
 * better upstream. Configuration belongs in @bam/config; enum casing belongs in
 * the auth layer.
 */

declare global {
  var __bamPrisma: PrismaClient | undefined;
}

export interface CreatePrismaClientOptions {
  databaseUrl: string;
  /** Emit query logs. Development only — queries can contain customer data. */
  logQueries?: boolean;
}

/**
 * Every session runs in UTC. Not a preference — a correctness requirement.
 *
 * node-postgres serialises a JS `Date` as its UTC digits with no offset, and
 * PostgreSQL then reads that literal in the session's `TimeZone`. On a machine
 * set to Europe/Budapest, the instant `10:00:00Z` is written as
 * `2026-07-29 10:00:00+02` — the instant `08:00:00Z`, two hours early. Reads
 * apply the same offset in reverse, so a Prisma round-trip returns exactly what
 * it stored and every test that writes and reads through Prisma passes.
 *
 * What does not survive is any comparison PostgreSQL performs itself:
 * `available_at <= now()` in the outbox dispatcher, hold expiry, anything
 * evaluated in SQL rather than in TypeScript. Those are wrong by the local UTC
 * offset — and by a *different* amount in winter, which is the part that turns
 * a reproducible bug into an intermittent one.
 *
 * Pinning the session to UTC makes the digits the driver sends mean what they
 * say. It pairs with CLAUDE.md rule 13: a recurring schedule is wall-clock and
 * lives in `working_hours` as local `HH:mm`; everything stored as `timestamptz`
 * is an instant, and an instant has exactly one correct reading.
 */
const FORCE_UTC_SESSION = "-c timezone=UTC";

export function createPrismaClient(options: CreatePrismaClientOptions): PrismaClient {
  // Prisma 7 connects through a driver adapter rather than a datasource URL in
  // the schema. `node-postgres` under the hood, so pool tuning is available here
  // when load testing in Epic 10 calls for it.
  const adapter = new PrismaPg({
    connectionString: options.databaseUrl,
    options: FORCE_UTC_SESSION,
  });

  return new PrismaClient({
    adapter,
    log: options.logQueries ? ["query", "warn", "error"] : ["warn", "error"],
  });
}

/**
 * Memoised client, reused across dev-server reloads so watch mode does not
 * exhaust the connection pool.
 *
 * Entry points should call {@link createPrismaClient} explicitly and manage its
 * lifecycle (the API does this in its database plugin). This helper is for
 * scripts and tests.
 */
export function getPrismaClient(options: CreatePrismaClientOptions): PrismaClient {
  globalThis.__bamPrisma ??= createPrismaClient(options);
  return globalThis.__bamPrisma;
}

/** Round-trip the connection. Used by `/health/ready`. */
export async function checkDatabaseConnection(
  client: PrismaClient,
): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
  const startedAt = performance.now();

  try {
    await client.$queryRaw`SELECT 1`;
    return { ok: true, latencyMs: Math.round(performance.now() - startedAt) };
  } catch (error) {
    return {
      ok: false,
      latencyMs: Math.round(performance.now() - startedAt),
      // Message only. A driver error can carry the connection string, and this
      // value is returned over HTTP (CLAUDE.md rule 6).
      error: error instanceof Error ? error.name : "UnknownError",
    };
  }
}

/** Assert an extension is installed. Guards against a database provisioned
 *  without the extensions migration having run. */
export async function hasExtension(client: PrismaClient, name: string): Promise<boolean> {
  const rows = await client.$queryRaw<{ count: bigint }[]>`
    SELECT COUNT(*)::bigint AS count FROM pg_extension WHERE extname = ${name}
  `;
  return (rows[0]?.count ?? 0n) > 0n;
}
