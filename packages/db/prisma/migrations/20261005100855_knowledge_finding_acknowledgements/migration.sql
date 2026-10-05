-- CreateTable
CREATE TABLE "knowledge_finding_acknowledgements" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "finding_key" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "excerpt" TEXT NOT NULL,
    "acknowledged_by_user_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "knowledge_finding_acknowledgements_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "knowledge_finding_acknowledgements_tenant_id_code_idx" ON "knowledge_finding_acknowledgements"("tenant_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "knowledge_finding_acknowledgements_tenant_id_finding_key_key" ON "knowledge_finding_acknowledgements"("tenant_id", "finding_key");

-- AddForeignKey
ALTER TABLE "knowledge_finding_acknowledgements" ADD CONSTRAINT "knowledge_finding_acknowledgements_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
