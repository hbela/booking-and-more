import { dispatchOutboxBatch, type DispatcherOptions } from "./outbox.dispatcher.js";

/**
 * Drives {@link dispatchOutboxBatch} on an interval.
 *
 * Polling rather than LISTEN/NOTIFY, which would be lower latency and is the
 * obvious temptation. It is not used because a NOTIFY is delivered to whoever
 * is connected at that moment and to nobody afterwards: a worker that is
 * restarting when the booking commits never learns of it, and the event waits
 * until something else happens to wake it. Polling has a floor on latency and
 * no such hole. The outbox is a catch-up mechanism; it should behave like one.
 */

export interface PollerOptions extends DispatcherOptions {
  intervalMs: number;
}

export interface OutboxPoller {
  /** Resolves once the loop has stopped and any in-flight batch has settled. */
  stop: () => Promise<void>;
}

export function startOutboxPoller(options: PollerOptions): OutboxPoller {
  let stopped = false;
  let inFlight: Promise<void> = Promise.resolve();

  const runBatch = async (): Promise<void> => {
    try {
      let keepGoing = true;

      // Drain rather than sleeping between batches: a backlog after a restart
      // would otherwise take (backlog / batchSize) × interval to clear, which
      // for a night's worth of bookings is most of the morning.
      while (keepGoing && !stopped) {
        const summary = await dispatchOutboxBatch(options);

        if (summary.claimed > 0) {
          options.logger.info({ ...summary }, "outbox: batch dispatched");
        }

        keepGoing = summary.claimed === options.batchSize;
      }
    } catch (error) {
      // A failure here is the claim query itself failing — the database being
      // unreachable, most likely. Log and let the next tick try again; the
      // rows are still there.
      options.logger.error({ err: error }, "outbox: poll failed");
    }
  };

  const tick = (): void => {
    if (stopped) return;
    inFlight = runBatch();
  };

  const timer = setInterval(tick, options.intervalMs);

  // Drain anything left by a previous run without waiting out the first
  // interval — a restart should not add latency to work already queued.
  tick();

  return {
    stop: async () => {
      stopped = true;
      clearInterval(timer);
      await inFlight;
    },
  };
}
