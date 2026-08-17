import {
  createGoogleOAuthClient,
  type GoogleOAuthClient,
  type GoogleOAuthConfig,
} from "@bam/google-calendar";

/**
 * Google's OAuth endpoints, constructed on first use.
 *
 * CLAUDE.md rule 4, and the same shape as `stripe.client.ts` next door: with no
 * `GOOGLE_*` variables the API boots exactly as before and the integration
 * routes answer 503. A booking system must not refuse to start because nobody
 * has connected a calendar yet.
 *
 * The client itself holds no state beyond the three config strings — it is
 * `fetch` and nothing else (docs/phase-6-google-calendar-part-1.md §2.7) — so
 * memoising is about not rebuilding a closure per request rather than about
 * reusing a connection. It is memoised anyway, so that this file reads the same
 * as the Stripe one and a future reader does not have to work out why it
 * differs.
 */

let client: GoogleOAuthClient | undefined;

export function getGoogleOAuth(config: GoogleOAuthConfig): GoogleOAuthClient {
  client ??= createGoogleOAuthClient(config);
  return client;
}

/** Test seam: the singleton would otherwise leak a client secret between cases. */
export function resetGoogleOAuthForTests(): void {
  client = undefined;
}
