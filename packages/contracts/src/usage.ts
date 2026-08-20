import { z } from "zod";

/**
 * What a plan is allowed to spend, and on what.
 *
 * tech-impl §37 · PRD §11.
 *
 * This lives beside the entitlement table in `billing.ts` for the reason
 * docs/phase-9-subscription-lifecycle.md §3 gives about that one: a rule about
 * what a plan may do belongs in a single table that can be read in one sitting,
 * not scattered across the call sites that happen to need it. Re-pricing a plan
 * should mean editing `PLAN_QUOTAS` and nothing else.
 */

/**
 * Every metered category. Mirrors the `UsageCategory` enum in the Prisma schema
 * — deliberately restated rather than imported, because `@bam/contracts` has no
 * database dependency and is consumed by the web app, which has no Prisma
 * client. `usage.test.ts` in `@bam/db` asserts the two lists agree.
 */
export const usageCategorySchema = z.enum([
  "VOICE_TRANSCRIPTION",
  "AI_INPUT_TOKENS",
  "AI_OUTPUT_TOKENS",
  "TTS_CHARACTERS",
  "REALTIME_AUDIO_SECONDS",
  "EMAIL_SENT",
  "BOOKING_CREATED",
]);

export type UsageCategory = z.infer<typeof usageCategorySchema>;

/** Every plan a tenant can be on, including the one that is not sold. */
export const quotaPlanSchema = z.enum(["INTERNAL", "STARTER", "PROFESSIONAL"]);

export type QuotaPlan = z.infer<typeof quotaPlanSchema>;

/** The unit a category is counted in. Recorded on every event for legibility. */
export const USAGE_UNITS: Record<UsageCategory, string> = {
  VOICE_TRANSCRIPTION: "seconds",
  AI_INPUT_TOKENS: "tokens",
  AI_OUTPUT_TOKENS: "tokens",
  TTS_CHARACTERS: "characters",
  REALTIME_AUDIO_SECONDS: "seconds",
  EMAIL_SENT: "messages",
  BOOKING_CREATED: "bookings",
};

/**
 * `null` means unmetered — recorded, never refused.
 *
 * Two shapes of decision are encoded here and they are not the same thing:
 *
 *  - **A category with a number is capped.** PRD §11 sets the voice allowance
 *    per plan; a Starter tenant gets 100 voice commands a month. The allowance
 *    is expressed in *seconds of audio* rather than in commands, because seconds
 *    are what we are billed for and a "command" is however long somebody talks
 *    for. 100 commands at the 30-second cap is 3,000 seconds.
 *  - **A category with `null` is deliberately uncapped**, not merely unspecified.
 *    `EMAIL_SENT` and `BOOKING_CREATED` are recorded so a tenant's cost is
 *    legible, but refusing to send a booking confirmation because a tenant is
 *    chatty would break the product to save a fraction of a cent.
 *
 * `REALTIME_AUDIO_SECONDS` is zero on every plan: PRD §23 excludes realtime from
 * the MVP, and zero is a stronger statement than a missing row — an attempt to
 * meter it is refused rather than waved through.
 */
export const PLAN_QUOTAS: Record<QuotaPlan, Record<UsageCategory, number | null>> = {
  INTERNAL: {
    VOICE_TRANSCRIPTION: null,
    AI_INPUT_TOKENS: null,
    AI_OUTPUT_TOKENS: null,
    TTS_CHARACTERS: null,
    REALTIME_AUDIO_SECONDS: null,
    EMAIL_SENT: null,
    BOOKING_CREATED: null,
  },
  STARTER: {
    /** PRD §11: 100 voice commands a month, at the 30-second recording cap. */
    VOICE_TRANSCRIPTION: 3_000,
    // The Form plan has no AI entitlement. Zero makes every paid model call
    // fail closed even if a caller misses the higher-level feature gate.
    AI_INPUT_TOKENS: 0,
    AI_OUTPUT_TOKENS: 0,
    TTS_CHARACTERS: 0,
    REALTIME_AUDIO_SECONDS: 0,
    EMAIL_SENT: null,
    BOOKING_CREATED: null,
  },
  PROFESSIONAL: {
    /** PRD §11: 1,000 voice commands a month. */
    VOICE_TRANSCRIPTION: 30_000,
    AI_INPUT_TOKENS: 2_000_000,
    AI_OUTPUT_TOKENS: 400_000,
    TTS_CHARACTERS: 0,
    REALTIME_AUDIO_SECONDS: 0,
    EMAIL_SENT: null,
    BOOKING_CREATED: null,
  },
};

/**
 * The monthly allowance, or `null` for unmetered.
 *
 * An unrecognised plan is treated as `STARTER` rather than as unlimited. The
 * failure mode of guessing low is a customer who is refused a voice command they
 * paid for and complains; the failure mode of guessing high is an unbounded bill
 * nobody notices. `planForPrice` in `billing.ts` falls back the same way and for
 * the same reason.
 */
export function quotaFor(plan: string | null | undefined, category: UsageCategory): number | null {
  const parsed = quotaPlanSchema.safeParse(plan);
  const table = parsed.success ? PLAN_QUOTAS[parsed.data] : PLAN_QUOTAS.STARTER;

  return table[category];
}

/**
 * Would this call fit inside the allowance?
 *
 * Pure, and takes the already-consumed figure as a parameter, so the gate can be
 * unit-tested without a database and so the caller decides how that figure is
 * read (see `UsageService.assertAllowed`, which reads it inside the same
 * transaction it writes in).
 *
 * The comparison is `consumed + requested > limit`, so a request that exactly
 * fills the allowance is allowed and the next one is not. The alternative —
 * refusing the request that would reach the limit — makes the last unit of every
 * allowance unusable.
 */
export function isWithinQuota(args: {
  plan: string | null | undefined;
  category: UsageCategory;
  consumed: number;
  requested: number;
}): boolean {
  const limit = quotaFor(args.plan, args.category);

  if (limit === null) return true;

  return args.consumed + args.requested <= limit;
}

/**
 * The period key a usage row is aggregated under: the calendar month in UTC.
 *
 * UTC rather than the tenant's zone on purpose. A quota is a billing period, and
 * a tenant that moves zone — or one whose owner travels — must not get a second
 * allowance out of an hour's difference. Every aggregate row for every tenant
 * rolls over at the same instant, which also makes the numbers comparable.
 */
export function usagePeriodOf(at: Date = new Date()): string {
  const year = at.getUTCFullYear();
  const month = `${at.getUTCMonth() + 1}`.padStart(2, "0");

  return `${year}-${month}`;
}
