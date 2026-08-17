-- CreateEnum
CREATE TYPE "delegation_scope" AS ENUM ('AVAILABILITY', 'BOOKINGS');

-- CreateTable
CREATE TABLE "provider_delegations" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "provider_id" TEXT NOT NULL,
    "membership_id" TEXT NOT NULL,
    "scopes" "delegation_scope"[],
    "granted_by_user_id" TEXT,
    "granted_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "provider_delegations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "provider_delegations_tenant_id_membership_id_idx" ON "provider_delegations"("tenant_id", "membership_id");

-- CreateIndex
CREATE INDEX "provider_delegations_tenant_id_provider_id_idx" ON "provider_delegations"("tenant_id", "provider_id");

-- CreateIndex
CREATE UNIQUE INDEX "provider_delegations_provider_id_membership_id_key" ON "provider_delegations"("provider_id", "membership_id");

-- AddForeignKey
ALTER TABLE "provider_delegations" ADD CONSTRAINT "provider_delegations_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provider_delegations" ADD CONSTRAINT "provider_delegations_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "providers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provider_delegations" ADD CONSTRAINT "provider_delegations_membership_id_fkey" FOREIGN KEY ("membership_id") REFERENCES "memberships"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A grant with no scopes would read as "delegated" on every screen and confer
-- nothing — a revocation wearing a grant's clothes, and the first place somebody
-- looks when access mysteriously stops. phase-3-4-diary-delegation §2.5.
--
-- Hand-written because Prisma cannot express a CHECK, exactly as in
-- 20260729051900_availability_check_constraints. Safe against `db:drift-check`:
-- `prisma migrate diff` does not model CHECK constraints at all.
ALTER TABLE "provider_delegations"
  ADD CONSTRAINT "provider_delegations_scopes_not_empty"
  CHECK (cardinality("scopes") > 0);
