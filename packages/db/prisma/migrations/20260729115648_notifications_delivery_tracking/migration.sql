-- CreateEnum
CREATE TYPE "notification_channel" AS ENUM ('EMAIL', 'SMS', 'PUSH');

-- CreateEnum
CREATE TYPE "notification_type" AS ENUM ('BOOKING_CONFIRMATION', 'BOOKING_UPDATED', 'BOOKING_CANCELLED', 'BOOKING_REMINDER', 'CALENDAR_DISCONNECTED');

-- CreateEnum
CREATE TYPE "notification_status" AS ENUM ('PENDING', 'SENDING', 'SENT', 'FAILED', 'SKIPPED');

-- CreateTable
CREATE TABLE "notifications" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "booking_id" TEXT,
    "customer_id" TEXT,
    "type" "notification_type" NOT NULL,
    "channel" "notification_channel" NOT NULL DEFAULT 'EMAIL',
    "recipient" TEXT NOT NULL,
    "template" TEXT NOT NULL,
    "locale" TEXT NOT NULL,
    "status" "notification_status" NOT NULL DEFAULT 'PENDING',
    "provider_message_id" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "scheduled_at" TIMESTAMPTZ(3) NOT NULL,
    "sent_at" TIMESTAMPTZ(3),
    "dedupe_key" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "notifications_status_scheduled_at_idx" ON "notifications"("status", "scheduled_at");

-- CreateIndex
CREATE INDEX "notifications_tenant_id_booking_id_idx" ON "notifications"("tenant_id", "booking_id");

-- CreateIndex
CREATE UNIQUE INDEX "notifications_tenant_id_dedupe_key_key" ON "notifications"("tenant_id", "dedupe_key");

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
