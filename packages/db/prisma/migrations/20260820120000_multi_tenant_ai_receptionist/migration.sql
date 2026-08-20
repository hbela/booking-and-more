CREATE TYPE "conversation_channel" AS ENUM ('CHAT', 'VOICE');
CREATE TYPE "conversation_status" AS ENUM ('ACTIVE', 'COMPLETED', 'CANCELLED', 'EXPIRED');
CREATE TYPE "message_sender" AS ENUM ('CUSTOMER', 'ASSISTANT', 'SYSTEM');
CREATE TYPE "message_type" AS ENUM ('TEXT', 'VOICE', 'STRUCTURED');
CREATE TYPE "pending_action_status" AS ENUM ('PENDING', 'CONFIRMED', 'CANCELLED', 'EXPIRED');
CREATE TYPE "usage_category" AS ENUM ('VOICE_TRANSCRIPTION', 'AI_INPUT_TOKENS', 'AI_OUTPUT_TOKENS', 'TTS_CHARACTERS', 'REALTIME_AUDIO_SECONDS', 'EMAIL_SENT', 'BOOKING_CREATED');
CREATE TYPE "usage_reservation_status" AS ENUM ('RESERVED', 'SETTLED', 'RELEASED', 'EXPIRED');

CREATE TABLE "tenant_assistant_settings" (
  "tenant_id" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "persona_name" TEXT NOT NULL DEFAULT 'Assistant',
  "business_description" TEXT,
  "supported_locales" TEXT[] NOT NULL DEFAULT ARRAY['hu', 'en']::TEXT[],
  "escalation_message" TEXT,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "tenant_assistant_settings_pkey" PRIMARY KEY ("tenant_id")
);

CREATE TABLE "tenant_assistant_faqs" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "locale" TEXT NOT NULL,
  "question" TEXT NOT NULL,
  "answer" TEXT NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "sort_order" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "tenant_assistant_faqs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "conversation_sessions" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "customer_id" TEXT,
  "hold_id" TEXT,
  "booking_id" TEXT,
  "channel" "conversation_channel" NOT NULL DEFAULT 'CHAT',
  "locale" TEXT NOT NULL,
  "timezone" TEXT NOT NULL,
  "status" "conversation_status" NOT NULL DEFAULT 'ACTIVE',
  "machine_state" TEXT NOT NULL,
  "state_json" JSONB NOT NULL DEFAULT '{}',
  "token_hash" TEXT NOT NULL,
  "turn_count" INTEGER NOT NULL DEFAULT 0,
  "outcome_successful" BOOLEAN,
  "summary" TEXT,
  "last_activity_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at" TIMESTAMPTZ(3) NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "conversation_sessions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "conversation_messages" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "session_id" TEXT NOT NULL,
  "sender" "message_sender" NOT NULL,
  "message_type" "message_type" NOT NULL DEFAULT 'TEXT',
  "content" TEXT NOT NULL,
  "structured_content_json" JSONB,
  "input_tokens" INTEGER,
  "output_tokens" INTEGER,
  "redacted_at" TIMESTAMPTZ(3),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "conversation_messages_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "conversation_pending_actions" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "session_id" TEXT NOT NULL,
  "tool_name" TEXT NOT NULL,
  "arguments_json" JSONB NOT NULL,
  "preview_json" JSONB NOT NULL,
  "status" "pending_action_status" NOT NULL DEFAULT 'PENDING',
  "expires_at" TIMESTAMPTZ(3) NOT NULL,
  "confirmed_at" TIMESTAMPTZ(3),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "conversation_pending_actions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "usage_events" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "category" "usage_category" NOT NULL,
  "quantity" INTEGER NOT NULL,
  "unit" TEXT NOT NULL,
  "provider" TEXT,
  "model" TEXT,
  "estimated_cost_minor" INTEGER NOT NULL DEFAULT 0,
  "metadata_json" JSONB,
  "occurred_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "usage_events_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "usage_aggregates" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "period" TEXT NOT NULL,
  "category" "usage_category" NOT NULL,
  "quantity" INTEGER NOT NULL DEFAULT 0,
  "estimated_cost_minor" INTEGER NOT NULL DEFAULT 0,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "usage_aggregates_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "usage_reservations" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "period" TEXT NOT NULL,
  "input_tokens" INTEGER NOT NULL,
  "output_tokens" INTEGER NOT NULL,
  "status" "usage_reservation_status" NOT NULL DEFAULT 'RESERVED',
  "expires_at" TIMESTAMPTZ(3) NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "settled_at" TIMESTAMPTZ(3),
  CONSTRAINT "usage_reservations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "conversation_sessions_token_hash_key" ON "conversation_sessions"("token_hash");
CREATE INDEX "tenant_assistant_faqs_tenant_id_locale_active_sort_order_idx" ON "tenant_assistant_faqs"("tenant_id", "locale", "active", "sort_order");
CREATE INDEX "conversation_sessions_tenant_id_status_last_activity_at_idx" ON "conversation_sessions"("tenant_id", "status", "last_activity_at");
CREATE INDEX "conversation_sessions_status_expires_at_idx" ON "conversation_sessions"("status", "expires_at");
CREATE INDEX "conversation_messages_tenant_id_session_id_created_at_idx" ON "conversation_messages"("tenant_id", "session_id", "created_at");
CREATE INDEX "conversation_pending_actions_tenant_id_session_id_status_idx" ON "conversation_pending_actions"("tenant_id", "session_id", "status");
CREATE INDEX "conversation_pending_actions_status_expires_at_idx" ON "conversation_pending_actions"("status", "expires_at");
CREATE INDEX "usage_events_tenant_id_category_occurred_at_idx" ON "usage_events"("tenant_id", "category", "occurred_at");
CREATE UNIQUE INDEX "usage_aggregates_tenant_id_period_category_key" ON "usage_aggregates"("tenant_id", "period", "category");
CREATE INDEX "usage_reservations_tenant_id_period_status_idx" ON "usage_reservations"("tenant_id", "period", "status");
CREATE INDEX "usage_reservations_status_expires_at_idx" ON "usage_reservations"("status", "expires_at");

ALTER TABLE "tenant_assistant_settings" ADD CONSTRAINT "tenant_assistant_settings_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "tenant_assistant_faqs" ADD CONSTRAINT "tenant_assistant_faqs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "conversation_sessions" ADD CONSTRAINT "conversation_sessions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "conversation_sessions" ADD CONSTRAINT "conversation_sessions_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "conversation_sessions" ADD CONSTRAINT "conversation_sessions_hold_id_fkey" FOREIGN KEY ("hold_id") REFERENCES "booking_holds"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "conversation_sessions" ADD CONSTRAINT "conversation_sessions_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "conversation_messages" ADD CONSTRAINT "conversation_messages_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "conversation_messages" ADD CONSTRAINT "conversation_messages_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "conversation_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "conversation_pending_actions" ADD CONSTRAINT "conversation_pending_actions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "conversation_pending_actions" ADD CONSTRAINT "conversation_pending_actions_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "conversation_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "usage_aggregates" ADD CONSTRAINT "usage_aggregates_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "usage_reservations" ADD CONSTRAINT "usage_reservations_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
