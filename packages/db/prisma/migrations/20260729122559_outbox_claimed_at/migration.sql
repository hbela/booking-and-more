-- AlterTable
ALTER TABLE "outbox_events" ADD COLUMN     "claimed_at" TIMESTAMPTZ(3);
