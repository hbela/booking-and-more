-- CreateTable
CREATE TABLE "subscription_checkout_links" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "plan" "subscription_plan" NOT NULL,
    "trial" BOOLEAN NOT NULL DEFAULT false,
    "stripe_payment_link_id" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "consumed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "subscription_checkout_links_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "subscription_checkout_links_tenant_id_key" ON "subscription_checkout_links"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "subscription_checkout_links_stripe_payment_link_id_key" ON "subscription_checkout_links"("stripe_payment_link_id");

-- AddForeignKey
ALTER TABLE "subscription_checkout_links" ADD CONSTRAINT "subscription_checkout_links_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
