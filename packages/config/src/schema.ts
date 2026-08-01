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

  // --- Queues and notifications (Epic 5) -----------------------------------
  /**
   * BullMQ's backing store. Still optional: unset, the worker idles rather than
   * crash-looping, and the API's rate limiting uses an in-process store.
   *
   * `rediss://` passes this check too — the prefix test is deliberately loose
   * enough to accept TLS, which any hosted Redis should be using, because job
   * payloads reference bookings and their recipients.
   */
  REDIS_URL: z.string().startsWith("redis").optional(),

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
   * everything else keeps working. Needed for exactly one call —
   * `webhooks.constructEvent` — because a Payment Link requires no API call to
   * produce (phase-9-subscription-and-activation.md §5).
   */
  STRIPE_SECRET_KEY: z.string().min(1).optional(),

  /** Verifies webhook signatures. Paired with the key — see the superRefine. */
  STRIPE_WEBHOOK_SECRET: z.string().min(1).optional(),

  /**
   * A permanent Payment Link per sellable plan, created once in the Stripe
   * dashboard. A link rather than a Checkout Session because a session expires
   * within 24 hours and the subscribe window is 14 days, so an emailed checkout
   * URL would be dead for most of the period it exists to cover (§1.2).
   *
   * Unset simply means that plan is not offered — better than a button leading
   * to a blank Stripe page.
   */
  STRIPE_PAYMENT_LINK_STARTER: z.url().optional(),
  STRIPE_PAYMENT_LINK_PROFESSIONAL: z.url().optional(),

  /**
   * The same plans, without the free trial.
   * docs/phase-9-subscription-lifecycle.md §2.1.
   *
   * A Payment Link's trial is a property of the link, so it cannot be skipped
   * per customer the way Checkout's `trial_period_days` can. Two links per plan
   * is what buys the guide's trial-abuse protection while keeping §1.2's
   * decision: the server sends this one to anyone whose organization has
   * already used its trial.
   *
   * Unset means a repeat subscriber cannot resubscribe to that plan — which is
   * why the pairing is checked below rather than left to be discovered by a
   * customer trying to come back.
   */
  STRIPE_PAYMENT_LINK_STARTER_NO_TRIAL: z.url().optional(),
  STRIPE_PAYMENT_LINK_PROFESSIONAL_NO_TRIAL: z.url().optional(),

  /**
   * Stripe price IDs, which are how a plan is identified from here on
   * (docs/phase-9-subscription-lifecycle.md §2.4).
   *
   * `metadata[plan]` used to answer this and cannot any longer: a subscription
   * schedule phase carries `items[0].price` as a bare ID string with no
   * metadata attached, so a scheduled downgrade has nothing to read. Required
   * alongside the secret key — see the superRefine.
   */
  STRIPE_PRICE_STARTER: z.string().startsWith("price_").optional(),
  STRIPE_PRICE_PROFESSIONAL: z.string().startsWith("price_").optional(),

  /**
   * The trial length, for copy only — "start your 30-day free trial".
   *
   * Stripe owns the real one: it is configured on the Payment Link, and
   * `trial_end` on the subscription is what the screen counts down to once a
   * trial exists. This number is what we can say *before* there is a
   * subscription to read, and it must match what the links are configured with.
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
  // lifecycle slice on (§2.4). Missing, a scheduled downgrade resolves to no
  // plan at all and is silently ignored — the failure surfaces weeks later, as
  // a customer still on the plan they downgraded away from.
  if (env.STRIPE_SECRET_KEY !== undefined) {
    for (const key of ["STRIPE_PRICE_STARTER", "STRIPE_PRICE_PROFESSIONAL"] as const) {
      if (env[key] === undefined) {
        ctx.addIssue({
          code: "custom",
          path: [key],
          message: `${key} is required when STRIPE_SECRET_KEY is set — a plan is identified by its price ID, and without it a scheduled plan change cannot be resolved.`,
        });
      }
    }
  }

  // A plan sold with no no-trial link is a plan a returning customer cannot buy
  // (§2.1). They reach the subscription screen, pick the plan they used to have,
  // and get a 404 — which looks like our bug, because it is.
  for (const [plan, trial, noTrial] of [
    ["STARTER", env.STRIPE_PAYMENT_LINK_STARTER, env.STRIPE_PAYMENT_LINK_STARTER_NO_TRIAL],
    [
      "PROFESSIONAL",
      env.STRIPE_PAYMENT_LINK_PROFESSIONAL,
      env.STRIPE_PAYMENT_LINK_PROFESSIONAL_NO_TRIAL,
    ],
  ] as const) {
    if (trial !== undefined && noTrial === undefined) {
      ctx.addIssue({
        code: "custom",
        path: [`STRIPE_PAYMENT_LINK_${plan}_NO_TRIAL`],
        message: `STRIPE_PAYMENT_LINK_${plan}_NO_TRIAL is required alongside STRIPE_PAYMENT_LINK_${plan} — an organization that has already used its trial is sent the no-trial link, and without one it cannot resubscribe.`,
      });
    }
  }
});

export type Env = z.infer<typeof envSchema>;
