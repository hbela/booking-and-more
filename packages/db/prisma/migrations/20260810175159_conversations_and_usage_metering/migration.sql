-- CreateEnum
CREATE TYPE "conversation_channel" AS ENUM ('CHAT', 'VOICE', 'REALTIME_VOICE');

-- CreateEnum
CREATE TYPE "conversation_status" AS ENUM ('ACTIVE', 'COMPLETED', 'CANCELLED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "conversation_role" AS ENUM ('CUSTOMER', 'PROVIDER');

-- CreateEnum
CREATE TYPE "message_sender" AS ENUM ('CUSTOMER', 'ASSISTANT', 'SYSTEM');

-- CreateEnum
CREATE TYPE "message_type" AS ENUM ('TEXT', 'VOICE', 'STRUCTURED');

-- CreateEnum
CREATE TYPE "pending_action_status" AS ENUM ('PENDING', 'CONFIRMED', 'CANCELLED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "interpretation_status" AS ENUM ('PENDING', 'SUCCEEDED', 'REJECTED', 'FAILED');

-- CreateEnum
CREATE TYPE "usage_category" AS ENUM ('VOICE_TRANSCRIPTION', 'AI_INPUT_TOKENS', 'AI_OUTPUT_TOKENS', 'TTS_CHARACTERS', 'REALTIME_AUDIO_SECONDS', 'EMAIL_SENT', 'BOOKING_CREATED');

-- CreateTable
CREATE TABLE "conversation_sessions" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "customer_id" TEXT,
    "user_id" TEXT,
    "role" "conversation_role" NOT NULL DEFAULT 'CUSTOMER',
    "channel" "conversation_channel" NOT NULL DEFAULT 'CHAT',
    "locale" TEXT NOT NULL,
    "timezone" TEXT NOT NULL,
    "status" "conversation_status" NOT NULL DEFAULT 'ACTIVE',
    "machine_state" TEXT NOT NULL,
    "state_json" JSONB NOT NULL DEFAULT '{}',
    "token_hash" TEXT NOT NULL,
    "turn_count" INTEGER NOT NULL DEFAULT 0,
    "hold_id" TEXT,
    "booking_id" TEXT,
    "last_activity_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "conversation_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversation_messages" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "sender" "message_sender" NOT NULL,
    "messageType" "message_type" NOT NULL DEFAULT 'TEXT',
    "content" TEXT NOT NULL,
    "structured_content_json" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conversation_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
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

-- CreateTable
CREATE TABLE "voice_interactions" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "audio_duration_ms" INTEGER NOT NULL,
    "transcription_provider" TEXT NOT NULL,
    "transcription_model" TEXT NOT NULL,
    "transcript" TEXT,
    "detected_language" TEXT,
    "interpretation_status" "interpretation_status" NOT NULL DEFAULT 'PENDING',
    "intent" TEXT,
    "estimated_cost_minor" INTEGER NOT NULL DEFAULT 0,
    "audio_retained" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "voice_interactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
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

-- CreateTable
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

-- CreateIndex
CREATE UNIQUE INDEX "conversation_sessions_token_hash_key" ON "conversation_sessions"("token_hash");

-- CreateIndex
CREATE INDEX "conversation_sessions_tenant_id_status_idx" ON "conversation_sessions"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "conversation_sessions_status_expires_at_idx" ON "conversation_sessions"("status", "expires_at");

-- CreateIndex
CREATE INDEX "conversation_messages_session_id_created_at_idx" ON "conversation_messages"("session_id", "created_at");

-- CreateIndex
CREATE INDEX "conversation_pending_actions_session_id_status_idx" ON "conversation_pending_actions"("session_id", "status");

-- CreateIndex
CREATE INDEX "conversation_pending_actions_status_expires_at_idx" ON "conversation_pending_actions"("status", "expires_at");

-- CreateIndex
CREATE INDEX "voice_interactions_tenant_id_created_at_idx" ON "voice_interactions"("tenant_id", "created_at");

-- CreateIndex
CREATE INDEX "voice_interactions_created_at_idx" ON "voice_interactions"("created_at");

-- CreateIndex
CREATE INDEX "usage_events_tenant_id_category_occurred_at_idx" ON "usage_events"("tenant_id", "category", "occurred_at");

-- CreateIndex
CREATE UNIQUE INDEX "usage_aggregates_tenant_id_period_category_key" ON "usage_aggregates"("tenant_id", "period", "category");

-- AddForeignKey
ALTER TABLE "conversation_sessions" ADD CONSTRAINT "conversation_sessions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_sessions" ADD CONSTRAINT "conversation_sessions_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_sessions" ADD CONSTRAINT "conversation_sessions_hold_id_fkey" FOREIGN KEY ("hold_id") REFERENCES "booking_holds"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_sessions" ADD CONSTRAINT "conversation_sessions_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_messages" ADD CONSTRAINT "conversation_messages_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_messages" ADD CONSTRAINT "conversation_messages_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "conversation_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_pending_actions" ADD CONSTRAINT "conversation_pending_actions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_pending_actions" ADD CONSTRAINT "conversation_pending_actions_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "conversation_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "voice_interactions" ADD CONSTRAINT "voice_interactions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "voice_interactions" ADD CONSTRAINT "voice_interactions_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "conversation_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_aggregates" ADD CONSTRAINT "usage_aggregates_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
