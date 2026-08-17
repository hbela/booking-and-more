-- CreateEnum
CREATE TYPE "calendar_provider_type" AS ENUM ('GOOGLE');

-- CreateEnum
CREATE TYPE "calendar_integration_status" AS ENUM ('ACTIVE', 'NEEDS_RECONNECT', 'DISCONNECTED');

-- CreateEnum
CREATE TYPE "calendar_event_state" AS ENUM ('PRESENT', 'CANCELLED');

-- CreateEnum
CREATE TYPE "calendar_sync_status" AS ENUM ('PENDING', 'SYNCING', 'SYNCED', 'FAILED');

-- CreateTable
CREATE TABLE "calendar_integrations" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "provider_id" TEXT,
    "user_id" TEXT NOT NULL,
    "provider_type" "calendar_provider_type" NOT NULL DEFAULT 'GOOGLE',
    "account_email" TEXT NOT NULL,
    "sealed_access_token" TEXT,
    "sealed_refresh_token" TEXT,
    "access_token_expires_at" TIMESTAMPTZ(3),
    "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" "calendar_integration_status" NOT NULL DEFAULT 'ACTIVE',
    "last_error" TEXT,
    "connected_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "calendar_integrations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "calendar_mappings" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "calendar_integration_id" TEXT NOT NULL,
    "provider_id" TEXT NOT NULL,
    "external_calendar_id" TEXT NOT NULL,
    "calendar_name" TEXT,
    "read_busy" BOOLEAN NOT NULL DEFAULT false,
    "write_bookings" BOOLEAN NOT NULL DEFAULT true,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sync_token" TEXT,
    "watch_channel_id" TEXT,
    "watch_resource_id" TEXT,
    "watch_expires_at" TIMESTAMPTZ(3),
    "last_synced_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "calendar_mappings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "calendar_event_mappings" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "booking_id" TEXT NOT NULL,
    "calendar_mapping_id" TEXT NOT NULL,
    "external_event_id" TEXT NOT NULL,
    "external_event_etag" TEXT,
    "desired_state" "calendar_event_state" NOT NULL DEFAULT 'PRESENT',
    "desired_version" INTEGER NOT NULL,
    "synced_version" INTEGER,
    "sync_status" "calendar_sync_status" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimed_at" TIMESTAMPTZ(3),
    "last_synced_at" TIMESTAMPTZ(3),
    "last_error" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "calendar_event_mappings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "calendar_oauth_states" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "state_hash" TEXT NOT NULL,
    "provider_id" TEXT,
    "return_path" TEXT,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "consumed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "calendar_oauth_states_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "calendar_integrations_tenant_id_status_idx" ON "calendar_integrations"("tenant_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "calendar_integrations_tenant_id_provider_type_account_email_key" ON "calendar_integrations"("tenant_id", "provider_type", "account_email");

-- CreateIndex
CREATE INDEX "calendar_mappings_tenant_id_provider_id_active_idx" ON "calendar_mappings"("tenant_id", "provider_id", "active");

-- CreateIndex
CREATE UNIQUE INDEX "calendar_mappings_calendar_integration_id_external_calendar_key" ON "calendar_mappings"("calendar_integration_id", "external_calendar_id");

-- CreateIndex
CREATE INDEX "calendar_event_mappings_sync_status_next_attempt_at_idx" ON "calendar_event_mappings"("sync_status", "next_attempt_at");

-- CreateIndex
CREATE INDEX "calendar_event_mappings_tenant_id_sync_status_idx" ON "calendar_event_mappings"("tenant_id", "sync_status");

-- CreateIndex
CREATE UNIQUE INDEX "calendar_event_mappings_booking_id_calendar_mapping_id_key" ON "calendar_event_mappings"("booking_id", "calendar_mapping_id");

-- CreateIndex
CREATE UNIQUE INDEX "calendar_event_mappings_calendar_mapping_id_external_event__key" ON "calendar_event_mappings"("calendar_mapping_id", "external_event_id");

-- CreateIndex
CREATE UNIQUE INDEX "calendar_oauth_states_state_hash_key" ON "calendar_oauth_states"("state_hash");

-- CreateIndex
CREATE INDEX "calendar_oauth_states_tenant_id_user_id_idx" ON "calendar_oauth_states"("tenant_id", "user_id");

-- CreateIndex
CREATE INDEX "calendar_oauth_states_expires_at_idx" ON "calendar_oauth_states"("expires_at");

-- AddForeignKey
ALTER TABLE "calendar_integrations" ADD CONSTRAINT "calendar_integrations_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calendar_integrations" ADD CONSTRAINT "calendar_integrations_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "providers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calendar_integrations" ADD CONSTRAINT "calendar_integrations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calendar_mappings" ADD CONSTRAINT "calendar_mappings_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calendar_mappings" ADD CONSTRAINT "calendar_mappings_calendar_integration_id_fkey" FOREIGN KEY ("calendar_integration_id") REFERENCES "calendar_integrations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calendar_mappings" ADD CONSTRAINT "calendar_mappings_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "providers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calendar_event_mappings" ADD CONSTRAINT "calendar_event_mappings_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calendar_event_mappings" ADD CONSTRAINT "calendar_event_mappings_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calendar_event_mappings" ADD CONSTRAINT "calendar_event_mappings_calendar_mapping_id_fkey" FOREIGN KEY ("calendar_mapping_id") REFERENCES "calendar_mappings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calendar_oauth_states" ADD CONSTRAINT "calendar_oauth_states_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calendar_oauth_states" ADD CONSTRAINT "calendar_oauth_states_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
