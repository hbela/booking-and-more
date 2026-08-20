-- A provider-level escape hatch from service approval queues.
-- False preserves every existing service's `requires_approval` behaviour;
-- owners opt individual diaries into immediate confirmation explicitly.
ALTER TABLE "providers"
  ADD COLUMN "auto_confirm_bookings" BOOLEAN NOT NULL DEFAULT false;
