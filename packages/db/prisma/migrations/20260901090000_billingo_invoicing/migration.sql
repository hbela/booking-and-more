-- CreateTable
CREATE TABLE "billingo_partners" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "stripe_customer_id" TEXT NOT NULL,
    "billingo_partner_id" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "billingo_partners_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billingo_invoices" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "partner_id" TEXT NOT NULL,
    "stripe_invoice_id" TEXT NOT NULL,
    "billingo_document_id" INTEGER NOT NULL,
    "billingo_invoice_number" TEXT NOT NULL,
    "gross_total_minor" INTEGER NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "billingo_invoices_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "billingo_partners_tenant_id_key" ON "billingo_partners"("tenant_id");
CREATE UNIQUE INDEX "billingo_partners_stripe_customer_id_key" ON "billingo_partners"("stripe_customer_id");
CREATE UNIQUE INDEX "billingo_partners_billingo_partner_id_key" ON "billingo_partners"("billingo_partner_id");
CREATE UNIQUE INDEX "billingo_invoices_stripe_invoice_id_key" ON "billingo_invoices"("stripe_invoice_id");
CREATE UNIQUE INDEX "billingo_invoices_billingo_document_id_key" ON "billingo_invoices"("billingo_document_id");
CREATE INDEX "billingo_invoices_tenant_id_created_at_idx" ON "billingo_invoices"("tenant_id", "created_at");

-- AddForeignKey
ALTER TABLE "billingo_partners" ADD CONSTRAINT "billingo_partners_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "billingo_invoices" ADD CONSTRAINT "billingo_invoices_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "billingo_invoices" ADD CONSTRAINT "billingo_invoices_partner_id_fkey" FOREIGN KEY ("partner_id") REFERENCES "billingo_partners"("id") ON DELETE CASCADE ON UPDATE CASCADE;
