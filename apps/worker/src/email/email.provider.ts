import type { Logger } from "@bam/observability";

/**
 * Provider-neutral email delivery. tech-impl §27.
 *
 * The interface is the point. Resend is the provider today; the notification
 * sender never learns that, so swapping it is one adapter rather than a search
 * through every call site. `booking-for-all` called `new Resend(...)` inline
 * inside the route handler that needed it, which is why "send an email" there
 * means "know about Resend".
 */

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
  /** Stable across retries at the provider-call crash boundary. */
  idempotencyKey: string;
}

export type DeliveryResult =
  | { ok: true; providerMessageId: string | undefined }
  | {
      ok: false;
      /** Fed to @bam/notification-engine's classifier to decide about retrying. */
      statusCode?: number | undefined;
      code?: string | undefined;
      message: string;
    };

export interface EmailProvider {
  readonly name: string;
  /**
   * Whether a successful `send` means a message actually left the building.
   *
   * False for the logging provider, and the sender must not record `SENT` for a
   * provider that says so. Without this the two are indistinguishable in the
   * database — `status: SENT`, `provider_message_id: null` — which is how five
   * onboarding emails were believed sent while Resend had never been called.
   *
   * The irony is worth recording: `requestPaymentLink` refuses to send email
   * inline precisely because the predecessor "swallowed the failure, so an
   * owner who never received their link looked identical to one who did". The
   * logging provider reintroduced exactly that, one layer down, by returning
   * `ok: true`.
   */
  readonly delivers: boolean;
  send(message: EmailMessage): Promise<DeliveryResult>;
}

/**
 * Records safe metadata instead of sending the message.
 *
 * Used when no API key is configured. This is CLAUDE.md rule 4 in its most
 * literal form: a missing key degrades one feature and nothing else. Complete
 * bodies and recipients are deliberately excluded: invitation and booking
 * templates contain bearer links, and configuration can be missing in any
 * environment, including production.
 */
export function createLoggingProvider(logger: Logger): EmailProvider {
  return {
    name: "logger",
    // The whole point. `ok: true` below means "the body was written out", not
    // "the owner received it", and only this flag can tell the sender apart.
    delivers: false,
    send(message: EmailMessage): Promise<DeliveryResult> {
      logger.info(
        { recipientDomain: emailDomain(message.to) },
        "email: not sent — no provider configured",
      );

      return Promise.resolve({ ok: true, providerMessageId: undefined });
    },
  };
}

function emailDomain(address: string): string | undefined {
  const separator = address.lastIndexOf("@");
  return separator < 0 ? undefined : address.slice(separator + 1).toLowerCase();
}

export interface ResendProviderOptions {
  apiKey: string;
  from: string;
  logger: Logger;
}

/**
 * Resend, over its REST API.
 *
 * Deliberately `fetch` rather than the `resend` SDK. The SDK is a thin wrapper
 * over one HTTP call, and taking it on would add a dependency to the worker
 * whose only job here is to set two headers. More usefully, hand-rolling it
 * means the failure shape is ours: the status code reaches the retry classifier
 * (tech-impl §26.3) instead of being flattened into an SDK error class.
 */
export function createResendProvider(options: ResendProviderOptions): EmailProvider {
  return {
    name: "resend",
    delivers: true,

    async send(message: EmailMessage): Promise<DeliveryResult> {
      try {
        const response = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${options.apiKey}`,
            "Content-Type": "application/json",
            "Idempotency-Key": message.idempotencyKey,
          },
          body: JSON.stringify({
            from: options.from,
            to: [message.to],
            subject: message.subject,
            html: message.html,
            text: message.text,
          }),
        });

        const payload: unknown = await response.json().catch(() => null);

        if (!response.ok) {
          const error = payload as { name?: string; message?: string } | null;

          return {
            ok: false,
            statusCode: response.status,
            // Resend names its error conditions in `name`; the classifier knows
            // several of them by name and falls back to the status otherwise.
            code: error?.name,
            message: error?.message ?? `Resend returned ${String(response.status)}`,
          };
        }

        const success = payload as { id?: string } | null;
        return { ok: true, providerMessageId: success?.id };
      } catch (error) {
        // Never surfaces the API key: the message is the fetch failure only.
        const err = error as { code?: string; message?: string };

        return {
          ok: false,
          code: err.code,
          message: err.message ?? "email request failed",
        };
      }
    },
  };
}

export interface EmailProviderOptions {
  apiKey: string | undefined;
  from: string | undefined;
  logger: Logger;
}

let provider: EmailProvider | undefined;

/**
 * The process-wide provider, constructed on first use (rule 4).
 *
 * Both halves of the configuration are required together — @bam/config's schema
 * already refuses one without the other — so testing the key alone would be
 * enough. Both are tested anyway, because the narrowing is what lets `from` be
 * a `string` below rather than a `string | undefined` the compiler cannot rule
 * out.
 */
export function getEmailProvider(options: EmailProviderOptions): EmailProvider {
  if (provider !== undefined) return provider;

  if (options.apiKey === undefined || options.from === undefined) {
    // Env is read once at module load and this is memoised, so configuring the
    // key later has no effect until the worker restarts. Said plainly, because
    // "I set RESEND_API_KEY and nothing sends" is otherwise a long afternoon.
    options.logger.warn(
      "email: RESEND_API_KEY/EMAIL_FROM not configured — nothing will be delivered. Notifications are recorded SKIPPED without logging message bodies. Set both and restart the worker.",
    );
    provider = createLoggingProvider(options.logger);
    return provider;
  }

  provider = createResendProvider({
    apiKey: options.apiKey,
    from: options.from,
    logger: options.logger,
  });

  return provider;
}

/** Test seam. Not used in production paths. */
export function resetEmailProvider(): void {
  provider = undefined;
}
