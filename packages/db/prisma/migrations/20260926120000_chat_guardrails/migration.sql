ALTER TYPE "subscription_plan" ADD VALUE IF NOT EXISTS 'PROFESSIONAL_PLUS';
ALTER TABLE "conversation_sessions"
 ADD COLUMN "start_key_hash" TEXT,
 ADD COLUMN "start_request_hash" TEXT,
 ADD COLUMN "patient_characters" INTEGER NOT NULL DEFAULT 0,
 ADD COLUMN "ai_input_tokens" INTEGER NOT NULL DEFAULT 0,
 ADD COLUMN "ai_output_tokens" INTEGER NOT NULL DEFAULT 0,
 ADD COLUMN "processing_until" TIMESTAMPTZ(3),
 ADD COLUMN "processing_token" TEXT,
 ADD COLUMN "rate_window_start" TIMESTAMPTZ(3),
 ADD COLUMN "rate_window_count" INTEGER NOT NULL DEFAULT 0,
 ADD COLUMN "closed_at" TIMESTAMPTZ(3),
 ADD COLUMN "closure_reason" TEXT;
CREATE UNIQUE INDEX "conversation_sessions_tenant_id_start_key_hash_key" ON "conversation_sessions"("tenant_id", "start_key_hash");
CREATE TABLE "chat_usage_counters" (
 "tenant_id" TEXT NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
 "period" TEXT NOT NULL, "quantity" INTEGER NOT NULL DEFAULT 0,
 CONSTRAINT "chat_usage_counters_pkey" PRIMARY KEY ("tenant_id", "period")
);
-- The expiry worker closes legacy sessions and releases their pending holds.
UPDATE "conversation_sessions" SET "expires_at" = LEAST("expires_at", CURRENT_TIMESTAMP) WHERE "status" = 'ACTIVE';
