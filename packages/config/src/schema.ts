import { z } from "zod";

/**
 * The single source of truth for environment configuration.
 *
 * tech-impl §42. Keep this schema in sync with `.env.example` — the CI check
 * `pnpm --filter @bam/config test` asserts that every required key documented
 * there is also declared here.
 */

/**
 * An empty environment variable means the variable is not configured.
 *
 * Every optional key below is `.optional()`, which admits `undefined` and not
 * `""`, and every defaulted key only reaches its default when the key is
 * absent. That distinction is invisible from a `.env` file, where leaving a
 * line out and leaving it blank look like the same act — and it is not
 * available at all on a deployment platform. Coolify imports every variable
 * named anywhere in the compose file into its own environment manager and
 * writes each one into the env file it runs `docker compose` with, so a key
 * nobody filled in arrives set and empty rather than absent.
 *
 * The result was an API that would not boot, reporting eleven problems of
 * which every single one was a feature the operator had deliberately not
 * configured: `STRIPE_SECRET_KEY: Too small` for a deployment not selling
 * anything yet, and `TRIAL_PERIOD_DAYS: expected number to be >0` for a
 * default the schema was carrying two lines away. That is the exact opposite
 * of CLAUDE.md rule 4 — a missing key must degrade one feature, never take
 * the process down.
 *
 * Stripping here rather than per-field keeps it a property of the environment
 * as a whole: a key added later cannot forget to opt in.
 */
function dropEmptyValues(input: unknown): unknown {
  if (typeof input !== "object" || input === null) return input;

  return Object.fromEntries(
    Object.entries(input as Record<string, unknown>).filter(
      ([, value]) => !(typeof value === "string" && value.trim() === ""),
    ),
  );
}

const portSchema = z.coerce.number().int().min(1).max(65_535);

/**
 * A connection string has to survive being parsed as a URL.
 *
 * Both DATABASE_URL and REDIS_URL are assembled in the compose files by
 * interpolating a generated password into userinfo, and a password containing
 * `/` silently produces a different URL rather than an invalid one — the
 * authority ends at the first `/`, so `postgresql://u:ab/cd@postgres:5432/db`
 * has host `u:ab` and path `/cd@postgres:5432/db`. `openssl rand -base64`,
 * which is what this project's deployment guide recommended until the incident
 * in phase-10 §2.9, emits `/` roughly a quarter of the time at 24 bytes.
 *
 * Node's WHATWG parser is the right oracle for both consumers: ioredis uses it
 * directly, and Prisma's Rust parser implements the same specification. So
 * anything rejected here would have failed later anyway — as a connection error
 * naming a host nobody typed, at first use, in the worker's logs.
 *
 * Generate these with `openssl rand -hex 32`.
 */
function parsesAsUrl(value: string): boolean {
  return URL.canParse(value);
}

const URL_SAFE_PASSWORD_HINT =
  "could not be parsed as a URL. The usual cause is an unescaped character in the password — `/` in " +
  "particular ends the authority, so the rest of the string is read as a path. Generate passwords with " +
  "`openssl rand -hex 32` rather than `openssl rand -base64`.";

/** A `postgresql://` URL. Prisma Accelerate URLs are rejected on purpose. */
const postgresUrlSchema = z
  .string()
  .min(1, "must not be empty")
  .refine((value) => value.startsWith("postgres://") || value.startsWith("postgresql://"), {
    message:
      "must be a postgres:// or postgresql:// URL. Prisma Accelerate (prisma+postgres://) is not used " +
      "in this project — the DATABASE_URL/DIRECT_URL split caused repeated production incidents in the " +
      "predecessor project.",
  })
  .refine(parsesAsUrl, { message: URL_SAFE_PASSWORD_HINT });

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

  // --- Google Calendar (Epic 6, part 1) ------------------------------------
  /**
   * Where Google returns after consent. tech-impl §42.
   *
   * Shares `GOOGLE_CLIENT_ID`/`_SECRET` with sign-in above — one Google project,
   * one consent screen, one verification submission
   * (docs/phase-6-google-calendar-part-1.md §2.5). Only the *flow* is ours.
   *
   * No default is derived from `API_BASE_URL`, tempting as that is: this exact
   * string has to be registered in the Google console character for character,
   * and a value that appears by itself is one nobody thought to register. Absent
   * simply means calendar sync is off.
   */
  GOOGLE_REDIRECT_URI: z.url().optional(),

  /**
   * Master key for sealing Google refresh tokens. tech-impl §25.2.
   *
   * 64 hex characters — `openssl rand -hex 32`. Validated here rather than at
   * the first OAuth callback, because the alternative is discovering it in
   * production at the one moment a provider is watching.
   *
   * Hex and not base64 for the reason phase-10 §2.9 gives about passwords: a
   * base64 value can carry `/` and `+`, which survive an env file but make the
   * value painful to move and impossible to eyeball for truncation.
   *
   * **Rotating it strands every stored token.** The sealed format carries a `v1`
   * prefix so a future reader can accept two keys and re-seal on read; until
   * that exists, a rotation means every provider reconnects.
   */
  GOOGLE_TOKEN_ENCRYPTION_KEY: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/u, "must be 64 hex characters; generate with `openssl rand -hex 32`")
    .optional(),

  /**
   * How long a pending OAuth state row stays usable.
   *
   * Short on purpose: it spans one redirect to Google and back. Long enough for
   * somebody to read a consent screen carefully, not long enough for an
   * abandoned tab to be worth replaying.
   */
  CALENDAR_OAUTH_STATE_TTL_MINUTES: z.coerce.number().int().positive().default(15),

  /** How long an invitation link stays usable. */
  INVITATION_EXPIRY_HOURS: z.coerce.number().int().positive().default(168), // 7 days

  // --- Queues and notifications (Epic 5) -----------------------------------
  /**
   * BullMQ's backing store. Still optional: unset, the worker idles rather than
   * crash-looping, and the API's rate limiting uses an in-process store.
   *
   * `rediss://` passes this check too — the prefix test is deliberately loose
   * enough to accept TLS, which any hosted Redis should be using, because job
   * payloads reference bookings and their recipients.
   *
   * The credential belongs *in this URL* and there is deliberately no
   * `REDIS_PASSWORD` here to pair with it. The compose files do own a variable
   * by that name — it is what `--requirepass` and this URL are both built from
   * — but it stops at the compose layer. Two env vars carrying one secret is a
   * question about which of them wins, asked at the worst moment; ioredis takes
   * a URL, so the URL is the single source of truth.
   */
  REDIS_URL: z
    .string()
    .startsWith("redis")
    .refine(parsesAsUrl, { message: URL_SAFE_PASSWORD_HINT })
    .optional(),

  /**
   * Resend. Optional per CLAUDE.md rule 4: absent, notifications are recorded
   * and marked as undeliverable rather than taking the process down. Paired
   * with EMAIL_FROM below — see the superRefine.
   */
  RESEND_API_KEY: z.string().min(1).optional(),

  /**
   * The envelope sender, e.g. `Clinic <booking@example.com>`. No default is
   * possible: it has to be a domain verified with the provider, and a wrong
   * one fails at send time rather than at boot.
   */
  EMAIL_FROM: z.string().min(1).optional(),

  /** How long before a booking its reminder goes out. */
  BOOKING_REMINDER_LEAD_HOURS: z.coerce.number().int().positive().default(24),

  // --- Platform administration (Epic 9) ------------------------------------
  /**
   * How long a newly provisioned organization has to subscribe before it is
   * closed (phase-9 §2.6). Deliberately longer than INVITATION_EXPIRY_HOURS,
   * which is why resending an owner's invitation is a first-class action.
   */
  ONBOARDING_WINDOW_DAYS: z.coerce.number().int().positive().default(14),

  // --- Billing (Epic 9) ----------------------------------------------------
  /**
   * Stripe. Optional per rule 4: absent, the subscription screen says so and
   * everything else keeps working.
   *
   * It is now needed for three calls, not one: `webhooks.constructEvent`, the
   * customer-portal session, and creating the per-organization Payment Link
   * that `POST /v1/billing/subscribe` hands out
   * (docs/phase-9-duplicate-subscription-prevention.md §4.1). That last one is
   * new — the links used to be permanent URLs held in the four
   * `STRIPE_PAYMENT_LINK_*` variables this replaced.
   */
  STRIPE_SECRET_KEY: z.string().min(1).optional(),

  /** Verifies webhook signatures. Paired with the key — see the superRefine. */
  STRIPE_WEBHOOK_SECRET: z.string().min(1).optional(),

  /**
   * Stripe price IDs. A plan *is* its price from Epic 9's lifecycle slice on
   * (docs/phase-9-subscription-lifecycle.md §2.4), and since the duplicate-
   * prevention slice these also decide what can be sold at all: a link is built
   * from a price, so a plan with no price configured is a plan not offered.
   *
   * `metadata[plan]` used to answer the identification question and cannot any
   * longer: a subscription schedule phase carries `items[0].price` as a bare ID
   * string with no metadata attached, so a scheduled downgrade has nothing to
   * read. Required alongside the secret key — see the superRefine.
   */
  STRIPE_PRICE_STARTER: z.string().startsWith("price_").optional(),
  STRIPE_PRICE_PROFESSIONAL: z.string().startsWith("price_").optional(),

  /**
   * The free trial's length, in days.
   *
   * No longer copy-only. A Payment Link created per organization carries
   * `subscription_data.trial_period_days`, so this number is now what Stripe is
   * actually told — which is what let the trial/no-trial link pair go away
   * (docs/phase-9-duplicate-subscription-prevention.md §4.2). An organization
   * that has already used its trial gets a link created without the parameter
   * at all, rather than a second URL.
   *
   * `trial_end` on the subscription is still what the screen counts down to
   * once a trial exists; this is what we can say before there is one.
   */
  TRIAL_PERIOD_DAYS: z.coerce.number().int().positive().default(30),

  /**
   * How long an unattributable Stripe event keeps retrying.
   * docs/phase-9-subscription-lifecycle.md §4.
   *
   * `customer.subscription.created` carries no `client_reference_id`, so it can
   * only be matched by a subscription ID that `checkout.session.completed`
   * writes. Arriving in the other order — which Stripe permits — the lookup
   * finds nothing. Retrying briefly self-heals that within one poll; the
   * timeout is what stops a genuinely foreign subscription retrying forever.
   */
  STRIPE_EVENT_ORPHAN_TIMEOUT_MS: z.coerce.number().int().positive().default(900_000),

  /** Outbox dispatcher tuning (tech-impl §12). */
  OUTBOX_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(5_000),
  OUTBOX_BATCH_SIZE: z.coerce.number().int().positive().max(500).default(50),
  /**
   * Attempts before an outbox row is parked as FAILED. The row stays for
   * inspection; it is never silently dropped.
   */
  OUTBOX_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),

  /**
   * How often the notification sweep looks for rows the queue does not have.
   *
   * Slower than the outbox poll on purpose. This is the catch-up path for two
   * things that are not urgent to the second — a reminder crossing the
   * dispatcher's 15-minute queue horizon, and a Redis that lost every job in it
   * (docs/phase-5-booking-notifications.md §2.5).
   */
  NOTIFICATION_SWEEP_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),

  /**
   * How often the calendar sweep looks for rows the queue does not have.
   * docs/phase-6-google-calendar-part-1.md §2.2.
   *
   * Same catch-up role as the notification sweep and the same cadence, for the
   * same reason: a lost job and a stale claim are both recoverable within a
   * minute, and neither is urgent to the second. It is also what drains the
   * backfill after a provider connects, which is the one bulk workload here —
   * the batch size is the throttle against Google's rate limit.
   */
  CALENDAR_SWEEP_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),
  CALENDAR_SWEEP_BATCH_SIZE: z.coerce.number().int().positive().max(500).default(50),

  /**
   * Attempts before a calendar row is parked as FAILED.
   *
   * Higher than the outbox's 5 deliberately: a Google incident outlasts a
   * database blip, and the cost of parking early is a provider's diary silently
   * falling behind. BullMQ's own `attempts` is the ceiling on one job; this is
   * the budget for the row, which is the durable commitment (§2.2).
   */
  CALENDAR_MAX_ATTEMPTS: z.coerce.number().int().positive().default(8),

  /**
   * How many existing bookings are copied into a calendar the moment it is
   * selected. docs/phase-6-google-calendar-part-1.md §2.10.
   *
   * There has to be a backfill at all — an integration that shows an empty
   * calendar on the day you connect it looks broken — and it has to be bounded,
   * because a busy tenant's future diary is the one burst this feature
   * generates and Google allows roughly 600 requests per minute per user.
   *
   * 200 is about three months for a full-time provider. Beyond that the older
   * appointments are the ones least worth having in a phone's calendar, which is
   * why the cap takes the *soonest* rows rather than the most recent.
   */
  CALENDAR_BACKFILL_LIMIT: z.coerce.number().int().positive().max(2_000).default(200),

  /** Unset is valid — Sentry is simply not initialised. */
  SENTRY_DSN: z.url().optional(),

  // --- Booking defaults (tech-impl §42) ------------------------------------
  BOOKING_HOLD_DURATION_SECONDS: z.coerce.number().int().positive().default(300),
  /** Optional: absent disables only the public AI receptionist. */
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  ANTHROPIC_CHAT_MODEL: z.string().min(1).default("claude-sonnet-5"),
  CHAT_MAX_OUTPUT_TOKENS: z.coerce.number().int().positive().max(4_096).default(1_024),
  CONVERSATION_TTL_MINUTES: z.coerce.number().int().positive().default(1_440),
  CONVERSATION_MAX_TURNS: z.coerce.number().int().positive().max(100).default(40),
  PENDING_ACTION_TTL_SECONDS: z.coerce.number().int().positive().default(300),
  VOICE_MAX_DURATION_SECONDS: z.coerce.number().int().positive().default(30),
  VOICE_AUDIO_RETENTION_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
});

const refinedEnvSchema = baseEnvSchema.superRefine((env, ctx) => {
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

  // The calendar half of the same Google project. These two are a pair with each
  // other, not with the client credentials above: sign-in without calendar is
  // ordinary and stays legal, but a redirect URI with no encryption key is the
  // dangerous shape — the consent screen appears, the provider grants access,
  // and the callback then cannot seal the refresh token it was handed. The
  // failure lands after the irreversible step, which is the worst place for it.
  const hasRedirect = env.GOOGLE_REDIRECT_URI !== undefined;
  const hasCalendarKey = env.GOOGLE_TOKEN_ENCRYPTION_KEY !== undefined;

  if (hasRedirect !== hasCalendarKey) {
    ctx.addIssue({
      code: "custom",
      path: [hasRedirect ? "GOOGLE_TOKEN_ENCRYPTION_KEY" : "GOOGLE_REDIRECT_URI"],
      message:
        "GOOGLE_REDIRECT_URI and GOOGLE_TOKEN_ENCRYPTION_KEY must be set together, or both left unset to disable Google Calendar sync.",
    });
  }

  // Calendar needs the client credentials too, and it is worth its own message:
  // "why does Connect return 503" is otherwise answered by reading four
  // variables and guessing which one is missing.
  if (hasRedirect && env.GOOGLE_CLIENT_ID === undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["GOOGLE_CLIENT_ID"],
      message:
        "GOOGLE_REDIRECT_URI is set for Calendar sync, which also needs GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET — the same Google project serves both sign-in and Calendar.",
    });
  }

  // Same failure shape as the Google pair, one layer later: an API key with no
  // sender address gets all the way to Resend before failing, once per email,
  // asynchronously, where the only symptom is a queue full of retries.
  const hasApiKey = env.RESEND_API_KEY !== undefined;
  const hasSender = env.EMAIL_FROM !== undefined;

  if (hasApiKey !== hasSender) {
    ctx.addIssue({
      code: "custom",
      path: [hasApiKey ? "EMAIL_FROM" : "RESEND_API_KEY"],
      message:
        "RESEND_API_KEY and EMAIL_FROM must be set together, or both left unset to disable email delivery.",
    });
  }

  // The worst-timed failure of the three. A secret key with no webhook secret
  // boots fine, sells fine, takes the customer's money fine — and then cannot
  // verify the event that says they paid, so the organization stays gated with
  // a paid invoice against it. Caught at boot instead.
  if (env.STRIPE_SECRET_KEY !== undefined && env.STRIPE_WEBHOOK_SECRET === undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["STRIPE_WEBHOOK_SECRET"],
      message:
        "STRIPE_WEBHOOK_SECRET is required when STRIPE_SECRET_KEY is set — without it a completed payment cannot be verified, and the customer stays gated after paying.",
    });
  }

  // The price IDs are how a plan is identified everywhere from Epic 9's
  // lifecycle slice on (§2.4), and since the duplicate-prevention slice they
  // are also what a Payment Link is built from. Missing, two things break at
  // once: a scheduled downgrade resolves to no plan and is silently ignored —
  // surfacing weeks later as a customer still on the plan they downgraded away
  // from — and the plan cannot be sold at all.
  if (env.STRIPE_SECRET_KEY !== undefined) {
    for (const key of ["STRIPE_PRICE_STARTER", "STRIPE_PRICE_PROFESSIONAL"] as const) {
      if (env[key] === undefined) {
        ctx.addIssue({
          code: "custom",
          path: [key],
          message: `${key} is required when STRIPE_SECRET_KEY is set — a plan is identified by its price ID, and without it neither a payment link nor a scheduled plan change can be resolved.`,
        });
      }
    }
  }
});

/**
 * Blank-as-absent runs before validation, so `.optional()` and `.default()`
 * see what the operator meant rather than what the platform serialised.
 */
export const envSchema = z.preprocess(dropEmptyValues, refinedEnvSchema);

export type Env = z.infer<typeof envSchema>;
