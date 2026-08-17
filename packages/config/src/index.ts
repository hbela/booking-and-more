/* eslint-disable no-restricted-properties -- This is the one module allowed to
   read process.env. Everything else imports the validated result (CLAUDE.md rule 3). */

import { existsSync } from "node:fs";
import path from "node:path";
import { config as loadDotenv } from "dotenv";
import { envSchema, type Env } from "./schema.js";

export { envSchema, type Env } from "./schema.js";

/**
 * Find the repository's `.env` by walking up from the current directory.
 *
 * The repo keeps a single `.env` at the root, but scripts run from their own
 * package directory (`pnpm --filter @bam/db db:join-tenant` has cwd `packages/db`), so
 * dotenv's default cwd lookup misses it. Stops at the workspace root, marked by
 * `pnpm-workspace.yaml`.
 */
function findEnvFile(startDir: string): string | undefined {
  let dir = startDir;

  for (;;) {
    const candidate = path.join(dir, ".env");
    if (existsSync(candidate)) return candidate;

    // Stop once we have checked the workspace root.
    if (existsSync(path.join(dir, "pnpm-workspace.yaml"))) return undefined;

    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** Thrown when the environment is unusable. Deliberately not an AppError — this
 *  happens before the app exists, so it must not depend on @bam/contracts. */
export class EnvValidationError extends Error {
  public override readonly name = "EnvValidationError";

  constructor(public readonly problems: readonly string[]) {
    super(
      [
        `Invalid environment configuration (${String(problems.length)} problem${
          problems.length === 1 ? "" : "s"
        }):`,
        ...problems.map((problem) => `  - ${problem}`),
        "",
        "See .env.example for the full list of variables and what each one does.",
      ].join("\n"),
    );
  }
}

let cached: Env | undefined;

export interface LoadEnvOptions {
  /** Read from this object instead of `process.env`. Used by tests. */
  source?: NodeJS.ProcessEnv;
  /** Load `.env` from disk first. Off in production, where the platform injects real env vars. */
  loadDotenvFile?: boolean;
}

/**
 * Parse and validate the environment. Call once, at the process edge
 * (`server.ts`, `worker.ts`), before anything else is constructed.
 *
 * Throws {@link EnvValidationError} listing *every* problem at once, rather than
 * failing on the first one — chasing missing variables one boot at a time is
 * exactly the friction this is meant to remove.
 */
export function loadEnv(options: LoadEnvOptions = {}): Env {
  const { source, loadDotenvFile = process.env["NODE_ENV"] !== "production" } = options;

  if (loadDotenvFile && !source) {
    const envFile = findEnvFile(process.cwd());
    // `override: false` so real environment variables always beat the file.
    loadDotenv({ ...(envFile ? { path: envFile } : {}), override: false, quiet: true });
  }

  const result = envSchema.safeParse(source ?? process.env);

  if (!result.success) {
    const problems = result.error.issues.map((issue) => {
      const key = issue.path.join(".") || "(root)";
      return `${key}: ${issue.message}`;
    });
    throw new EnvValidationError(problems);
  }

  return result.data;
}

/**
 * Memoised accessor. Safe to call from anywhere after the first `loadEnv()`;
 * it will lazily load on first use if that has not happened yet.
 */
export function getEnv(): Env {
  cached ??= loadEnv();
  return cached;
}

/** Set the process-wide config. Called once by each app's entry point. */
export function setEnv(env: Env): void {
  cached = env;
}

/** Test-only: drop the memoised value. */
export function resetEnvCache(): void {
  cached = undefined;
}

/**
 * Load the environment or exit the process with a readable message.
 *
 * Entry points should use this rather than letting the error escape: an
 * unhandled throw here produces a stack trace that buries the actual problem.
 */
export function loadEnvOrExit(options: LoadEnvOptions = {}): Env {
  try {
    const env = loadEnv(options);
    setEnv(env);
    return env;
  } catch (error) {
    if (error instanceof EnvValidationError) {
      // process is about to exit; there is no logger yet.
      console.error(`\n${error.message}\n`);
      process.exit(1);
    }
    throw error;
  }
}

export const isProduction = (env: Env): boolean => env.NODE_ENV === "production";
export const isTest = (env: Env): boolean => env.NODE_ENV === "test";
export const isDevelopment = (env: Env): boolean => env.NODE_ENV === "development";

/** Redis is optional; unset, the worker idles and rate limiting stays in-process. */
export const hasRedis = (env: Env): boolean => env.REDIS_URL !== undefined;

/**
 * Whether email can actually be delivered.
 *
 * The schema guarantees the key and the sender travel together, so testing one
 * would do — testing both keeps the guarantee readable at the call site rather
 * than requiring the reader to remember the superRefine.
 */
export const hasEmail = (env: Env): boolean =>
  env.RESEND_API_KEY !== undefined && env.EMAIL_FROM !== undefined;

/**
 * Whether a provider can connect a Google Calendar.
 * docs/phase-6-google-calendar-part-1.md §2.5.
 *
 * Four variables, and all four are needed: the client pair is shared with Google
 * sign-in, the redirect URI has to match what is registered in the Google
 * console, and without the encryption key a callback could not seal the refresh
 * token it is handed.
 *
 * False is an ordinary state, not an error. The integration routes answer 503
 * and the dashboard says the platform has not configured it — rule 4, one
 * feature degraded and nothing else touched. Notably `hasGoogleSignIn` can be
 * true while this is false, which is the common case for a deployment that
 * offers Google login and no calendar sync.
 */
export const hasGoogleCalendar = (env: Env): boolean =>
  env.GOOGLE_CLIENT_ID !== undefined &&
  env.GOOGLE_CLIENT_SECRET !== undefined &&
  env.GOOGLE_REDIRECT_URI !== undefined &&
  env.GOOGLE_TOKEN_ENCRYPTION_KEY !== undefined;

/** Sign-in only. Deliberately distinct from {@link hasGoogleCalendar}. */
export const hasGoogleSignIn = (env: Env): boolean =>
  env.GOOGLE_CLIENT_ID !== undefined && env.GOOGLE_CLIENT_SECRET !== undefined;
