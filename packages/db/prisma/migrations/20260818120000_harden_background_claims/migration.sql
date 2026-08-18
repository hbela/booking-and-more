-- Recover notifications abandoned after a worker claimed them.
ALTER TABLE "notifications"
ADD COLUMN "claimed_at" TIMESTAMPTZ(3);

ALTER TABLE "audit_logs"
ADD COLUMN "source_key" TEXT;

CREATE UNIQUE INDEX "audit_logs_source_key_key" ON "audit_logs"("source_key");

-- Reject stale Stripe state without conflating subscription and schedule
-- timelines, and lease webhook processing across worker replicas.
ALTER TABLE "subscriptions"
ADD COLUMN "last_stripe_state_event_at" TIMESTAMPTZ(3),
ADD COLUMN "last_stripe_state_event_id" TEXT,
ADD COLUMN "last_stripe_schedule_event_at" TIMESTAMPTZ(3),
ADD COLUMN "last_stripe_schedule_event_id" TEXT;

ALTER TABLE "stripe_events"
ADD COLUMN "event_created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN "claimed_at" TIMESTAMPTZ(3),
ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 0;

DROP INDEX IF EXISTS "stripe_events_processed_at_idx";
CREATE INDEX "stripe_events_processed_at_claimed_at_event_created_at_idx"
ON "stripe_events"("processed_at", "claimed_at", "event_created_at");
