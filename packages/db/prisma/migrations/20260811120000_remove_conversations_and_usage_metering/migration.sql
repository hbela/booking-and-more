-- Reverses 20260810175159_conversations_and_usage_metering, applied the day
-- before and never released.
--
-- Epics 7 and 8 — chat booking and push-to-talk voice — are withdrawn. The
-- classic booking form is the product's customer path, and the conversational
-- one was a second way to reach the same hold: two journeys to keep in step, a
-- per-request cost, and a model in the middle of the one flow that has to work.
-- The code went with `git revert`; this is the schema half of the same decision.
--
-- No data migration, and none possible: every row in these six tables belongs
-- to a conversation that no longer has an interface. A booking a conversation
-- made is unaffected — `conversation_sessions.booking_id` is the nullable side
-- of that link, so the booking rows, their snapshots (rule 15) and their
-- capacity reservations are untouched by dropping it.
--
-- Order matters. The three children of `conversation_sessions` hold foreign
-- keys into it, so they go first; `usage_events` and `usage_aggregates` only
-- reference `tenants`. The enums are dropped last, after the columns typed by
-- them are gone — a `DROP TYPE` with a dependant still standing errors rather
-- than cascading, which is the behaviour wanted here.

-- DropTable
DROP TABLE "conversation_messages";

-- DropTable
DROP TABLE "conversation_pending_actions";

-- DropTable
DROP TABLE "voice_interactions";

-- DropTable
DROP TABLE "conversation_sessions";

-- DropTable
DROP TABLE "usage_events";

-- DropTable
DROP TABLE "usage_aggregates";

-- DropEnum
DROP TYPE "conversation_channel";

-- DropEnum
DROP TYPE "conversation_status";

-- DropEnum
DROP TYPE "conversation_role";

-- DropEnum
DROP TYPE "message_sender";

-- DropEnum
DROP TYPE "message_type";

-- DropEnum
DROP TYPE "pending_action_status";

-- DropEnum
DROP TYPE "interpretation_status";

-- DropEnum
DROP TYPE "usage_category";
