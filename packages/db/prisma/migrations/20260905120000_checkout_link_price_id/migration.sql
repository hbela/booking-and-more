-- Existing rows deliberately remain NULL. Stripe Prices are immutable, and
-- the application will replace these legacy links the next time they are used
-- rather than guessing which catalogue version created them.
ALTER TABLE "subscription_checkout_links"
ADD COLUMN "stripe_price_id" TEXT;
