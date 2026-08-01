import { z } from "zod";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { UnauthenticatedError } from "@bam/contracts";

import { getStripe } from "./stripe.client.js";

/**
 * Stripe's webhook. docs/phase-9-subscription-and-activation.md §3.3.
 *
 * Three things here are not like any other route in this codebase, each for a
 * reason worth stating.
 *
 * **1. The body is a raw Buffer.** Signature verification hashes the exact
 * bytes Stripe sent; Fastify's JSON parser destroys them by round-tripping
 * through an object. The parser below is registered inside this plugin only,
 * so Fastify's encapsulation keeps every other route on the normal one. A
 * global raw-body parser would be the usual mistake here.
 *
 * **2. There is no Zod schema for the body.** A documented exception to rule 2,
 * exactly like the Better Auth bridge in auth.plugin.ts: the payload's
 * validator is Stripe's signature, and a Zod schema would be a second,
 * divergent source of truth that also could not run until after verification.
 *
 * **3. It records and returns; it does not act.** Stripe delivers at-least-once
 * and retries anything slow, so doing the work inline is what *causes* the
 * duplicate delivery it is trying to handle (phase-9 §2.9). The worker polls
 * `stripe_events` and decides.
 */

export interface WebhookRoutesOptions {
  stripeSecretKey: string;
  webhookSecret: string;
}

export const stripeWebhookRoutes: FastifyPluginAsyncZod<WebhookRoutesOptions> = async (
  app,
  options,
) => {
  // Scoped to this plugin. `parseAs: "buffer"` hands the handler the bytes
  // Stripe signed rather than a parsed object.
  app.addContentTypeParser("application/json", { parseAs: "buffer" }, (_request, body, done) => {
    done(null, body);
  });

  app.post(
    "/stripe",
    {
      config: {
        // Unauthenticated by necessity — Stripe holds no session. The signature
        // is the authentication. A limit still helps: an unsigned flood should
        // not reach the verifier.
        rateLimit: { max: 100, timeWindow: "1 minute" },
      },
      schema: {
        tags: ["billing"],
        summary: "Stripe webhook",
        description:
          "Signature-verified, unauthenticated. Records the event and returns 200 without acting on it; the worker processes stripe_events. A redelivered event id is recorded once and answered 200.",
        // No body schema — see the note above. Stripe's signature is the
        // validator, and it runs on bytes this cannot see.
        response: {
          200: z.object({ received: z.boolean() }),
        },
      },
    },
    async (request, reply) => {
      const signature = request.headers["stripe-signature"];

      if (typeof signature !== "string") {
        throw new UnauthenticatedError("Missing Stripe signature.");
      }

      const stripe = getStripe({ secretKey: options.stripeSecretKey });

      let event: { id: string; type: string };

      try {
        // Throws on a bad signature, a replayed timestamp, or a tampered body.
        event = stripe.webhooks.constructEvent(
          request.body as Buffer,
          signature,
          options.webhookSecret,
        );
      } catch (error) {
        // Deliberately not logged at error level with the payload attached: an
        // unverified body is attacker-controlled, and this endpoint is public.
        request.log.warn({ err: error }, "stripe: signature verification failed");
        throw new UnauthenticatedError("Invalid Stripe signature.");
      }

      try {
        await app.prisma.stripeEvent.create({
          data: {
            id: event.id,
            type: event.type,
            payload: JSON.parse((request.body as Buffer).toString("utf8")) as object,
          },
        });
      } catch (error) {
        // P2002 on the primary key means Stripe redelivered something already
        // recorded. That is a success, not a failure: answering anything else
        // makes Stripe retry a duplicate it has already delivered. The database
        // decides, application code translates (rule 14).
        if (!isUniqueViolation(error)) throw error;

        request.log.info({ eventId: event.id }, "stripe: event already recorded");
      }

      return reply.status(200).send({ received: true });
    },
  );
};

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "P2002"
  );
}
