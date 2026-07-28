import { z } from "zod";

/**
 * The single source of truth for environment configuration.
 *
 * tech-impl §42. Keep this schema in sync with `.env.example` — the CI check
 * `pnpm --filter @bam/config test` asserts that every required key documented
 * there is also declared here.
 */

const portSchema = z.coerce.number().int().min(1).max(65_535);

/** A `postgresql://` URL. Prisma Accelerate URLs are rejected on purpose. */
const postgresUrlSchema = z
  .string()
  .min(1, "must not be empty")
  .refine((value) => value.startsWith("postgres://") || value.startsWith("postgresql://"), {
    message:
      "must be a postgres:// or postgresql:// URL. Prisma Accelerate (prisma+postgres://) is not used " +
      "in this project — the DATABASE_URL/DIRECT_URL split caused repeated production incidents in the " +
      "predecessor project.",
  });

const baseEnvSchema = z.object({
  // --- Core -----------------------------------------------------------------
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),

  /** Public origin of the Next.js app. Doubles as the sole allowed CORS origin. */
  APP_BASE_URL: z.url(),
  /** Public origin of the Fastify API. */
  API_BASE_URL: z.url(),
  PORT: portSchema.default(3001),

  // --- Database -------------------------------------------------------------
  DATABASE_URL: postgresUrlSchema,

  // --- Authentication (Epic 1) ---------------------------------------------
  /**
   * Better Auth signing secret. Required, and required to be stable: rotating
   * it invalidates every live session.
   *
   * 32 characters is the floor rather than a suggestion — a short secret here
   * undermines every session cookie the platform issues.
   */
  BETTER_AUTH_SECRET: z
    .string()
    .min(32, "must be at least 32 characters; generate with `openssl rand -base64 32`"),

  /**
   * Google sign-in. Optional, but both halves are needed or neither — see the
   * superRefine below. A missing key degrades one feature; it does not break
   * boot (CLAUDE.md rule 4).
   */
  GOOGLE_CLIENT_ID: z.string().min(1).optional(),
  GOOGLE_CLIENT_SECRET: z.string().min(1).optional(),

  /** How long an invitation link stays usable. */
  INVITATION_EXPIRY_HOURS: z.coerce.number().int().positive().default(168), // 7 days

  // --- Optional in Phase 0 --------------------------------------------------
  /**
   * Redis arrives in Epic 5 (BullMQ, outbox dispatch, distributed rate limiting).
   * While unset: the worker idles and rate limiting uses an in-process store.
   */
  REDIS_URL: z.string().startsWith("redis").optional(),

  /** Unset is valid — Sentry is simply not initialised. */
  SENTRY_DSN: z.url().optional(),

  // --- Booking defaults (tech-impl §42) ------------------------------------
  BOOKING_HOLD_DURATION_SECONDS: z.coerce.number().int().positive().default(300),
  VOICE_MAX_DURATION_SECONDS: z.coerce.number().int().positive().default(30),
  VOICE_AUDIO_RETENTION_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
});

export const envSchema = baseEnvSchema.superRefine((env, ctx) => {
  // Half-configured OAuth is worse than none: Better Auth would register the
  // provider and every sign-in attempt would fail at Google with an opaque
  // error. Catch it at boot instead.
  const hasId = env.GOOGLE_CLIENT_ID !== undefined;
  const hasSecret = env.GOOGLE_CLIENT_SECRET !== undefined;

  if (hasId !== hasSecret) {
    ctx.addIssue({
      code: "custom",
      path: [hasId ? "GOOGLE_CLIENT_SECRET" : "GOOGLE_CLIENT_ID"],
      message:
        "GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set together, or both left unset to disable Google sign-in.",
    });
  }
});

export type Env = z.infer<typeof envSchema>;
