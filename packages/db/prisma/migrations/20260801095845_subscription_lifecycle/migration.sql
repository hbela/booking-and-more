-- AlterTable
ALTER TABLE "subscriptions" ADD COLUMN     "pending_plan" "subscription_plan",
ADD COLUMN     "pending_plan_starts_at" TIMESTAMPTZ(3),
ADD COLUMN     "stripe_price_id" TEXT,
ADD COLUMN     "stripe_schedule_id" TEXT,
ADD COLUMN     "trial_ends_at" TIMESTAMPTZ(3),
ADD COLUMN     "trial_used_at" TIMESTAMPTZ(3);
