import { processStripeEventBatch, type StripeProcessorOptions } from "./stripe.processor.js";

/**
 * Drives {@link processStripeEventBatch} on an interval.
 *
 * The same shape as the outbox poller, for the same reasons — and deliberately
 * not a BullMQ queue. `stripe_events` already carries `processed_at` and
 * `last_error`, which is a table designed for a claim-and-mark loop; adding a
 * queue would put the same state in two places and give a redelivered webhook
 * two ways to be in flight at once.
 *
 * It also means an event survives Redis being down: the webhook writes to
 * PostgreSQL and returns 200, so Stripe is satisfied even if nothing is
 * processing yet.
 */

export interface StripePollerOptions extends StripeProcessorOptions {
  intervalMs: number;
}

export interface StripePoller {
  /** Resolves once the loop has stopped and any in-flight batch has settled. */
  stop: () => Promise<void>;
}

export function startStripePoller(options: StripePollerOptions): StripePoller {
  let stopped = false;
  let inFlight: Promise<void> = Promise.resolve();

  const runBatch = async (): Promise<void> => {
    try {
      let keepGoing = true;

      // Drain rather than sleeping between batches, so a backlog after a
      // restart clears at once instead of one batch per interval.
      while (keepGoing && !stopped) {
        const summary = await processStripeEventBatch(options);

        if (summary.claimed > 0) {
          options.logger.info({ ...summary }, "stripe: batch processed");
        }

        // A batch that was entirely failures would otherwise spin: every row
        // stays unprocessed, so the next query returns the same rows forever.
        // Stop and let the interval space out the retries.
        keepGoing = summary.claimed === options.batchSize && summary.processed > 0;
      }
    } catch (error) {
      // The query itself failed — the database being unreachable, most likely.
      // The rows are still there; the next tick tries again.
      options.logger.error({ err: error }, "stripe: poll failed");
    }
  };

  const tick = (): void => {
    if (stopped) return;
    inFlight = runBatch();
  };

  const timer = setInterval(tick, options.intervalMs);

  // Drain anything a previous run left without waiting out the first interval:
  // a customer who paid during a deploy should not wait for it.
  tick();

  return {
    stop: async () => {
      stopped = true;
      clearInterval(timer);
      await inFlight;
    },
  };
}
