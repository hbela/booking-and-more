ALTER TABLE "customers" ADD COLUMN "email_blind_index" TEXT, ADD COLUMN "phone_blind_index" TEXT;
CREATE INDEX "customers_tenant_id_email_blind_index_idx" ON "customers"("tenant_id", "email_blind_index");
CREATE INDEX "customers_tenant_id_phone_blind_index_idx" ON "customers"("tenant_id", "phone_blind_index");
CREATE TABLE "billing_transition_archives" ("tenant_id" TEXT NOT NULL, "sealed_snapshot" TEXT NOT NULL, "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "billing_transition_archives_pkey" PRIMARY KEY ("tenant_id"));
