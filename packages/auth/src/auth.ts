import { betterAuth } from "better-auth";
import { prismaAdapter } from "@better-auth/prisma-adapter";
import type { PrismaClient } from "@bam/db";

/**
 * Better Auth instance factory.
 *
 * ## Scope: identity only
 *
 * Better Auth owns **who you are** — users, sessions, credentials, verification.
 * It owns nothing about **what you may do**: tenants, memberships, roles and
 * permissions are ours (see roles.ts and policy.ts).
 *
 * In particular we deliberately do **not** use Better Auth's `organization`
 * plugin, even though it would appear to fit. Three reasons:
 *
 *  1. Our `Tenant` is a domain entity (timezone, booking policy, cancellation
 *     policy, branding — tech-impl §10.1), not a generic org record.
 *  2. Our `Membership` carries `providerId` and a lifecycle `status` that the
 *     plugin has no concept of.
 *  3. The predecessor project used the plugin *and* kept its own roles, which
 *     left two role systems disagreeing about the same user. Owning tenancy
 *     outright means there is exactly one answer to "what may this person do".
 *
 * The cost is that we write the membership CRUD ourselves. That is a good
 * trade: it is the part we most need to be able to test and audit.
 */

export interface CreateAuthOptions {
  prisma: PrismaClient;
  /** Signing secret. Must be stable across restarts or every session is invalidated. */
  secret: string;
  /** Public origin of this API — where Better Auth's own routes live. */
  baseUrl: string;
  /** Public origin of the web app. Allowed to receive auth cookies. */
  appUrl: string;
  /** Cross-site cookies require HTTPS; in local development they must not. */
  secureCookies: boolean;
  /**
   * Google sign-in. Omitted entirely when credentials are absent, rather than
   * registered with empty strings — a missing key degrades one feature instead
   * of breaking boot (CLAUDE.md rule 4).
   */
  google?: { clientId: string; clientSecret: string } | undefined;
}

export function createAuth(options: CreateAuthOptions) {
  const { prisma, secret, baseUrl, appUrl, secureCookies, google } = options;

  return betterAuth({
    appName: "booking-and-more",
    secret,
    baseURL: baseUrl,
    basePath: "/v1/auth",

    database: prismaAdapter(prisma, { provider: "postgresql" }),

    // Staff sign-in. Customers are not required to hold a password to book
    // (tech-impl §8.2) — they arrive as guests or through a management token.
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 12,
      // Email verification arrives with the notification worker in Epic 5;
      // until there is a way to actually deliver the mail, requiring it would
      // lock every new account out.
      requireEmailVerification: false,
      autoSignIn: true,
    },

    ...(google ? { socialProviders: { google } } : {}),

    user: {
      additionalFields: {
        /**
         * Platform operator flag. `input: false` is the important part: it
         * makes the field unwritable through any Better Auth request, so a
         * crafted sign-up body cannot grant itself platform admin. It is set
         * only by a deliberate server-side script.
         */
        isPlatformAdmin: {
          type: "boolean",
          required: false,
          defaultValue: false,
          input: false,
        },
      },
    },

    session: {
      expiresIn: 60 * 60 * 24 * 7, // 7 days
      updateAge: 60 * 60 * 24, // refresh at most daily
      // Session lookups happen on every authenticated request; without this the
      // API would hit the database twice per call just to know who is asking.
      cookieCache: { enabled: true, maxAge: 60 },
    },

    // The web app is a separate origin from the API, so its origin must be
    // trusted explicitly. This list is not a CORS policy — it governs which
    // origins Better Auth will issue and accept credentials for.
    trustedOrigins: [appUrl],

    advanced: {
      defaultCookieAttributes: {
        httpOnly: true,
        sameSite: secureCookies ? "none" : "lax",
        secure: secureCookies,
      },
      cookiePrefix: "bam",
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;
export type AuthSession = Auth["$Infer"]["Session"];
