-- AlterTable
ALTER TABLE "invitations" ADD COLUMN     "delegated_provider_id" TEXT,
ADD COLUMN     "delegated_scopes" "delegation_scope"[];

-- AddForeignKey
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_delegated_provider_id_fkey" FOREIGN KEY ("delegated_provider_id") REFERENCES "providers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A delegation that names a diary and no scopes, or scopes and no diary, is a
-- grant that means nothing — and it would be created by exactly the sort of
-- partial write this constraint exists to make impossible.
-- docs/phase-3-4-diary-delegation.md §2.13.
--
-- Hand-written because Prisma cannot express a CHECK, and invisible to
-- `prisma migrate diff`, which does not model them.
ALTER TABLE "invitations"
  ADD CONSTRAINT "invitations_delegation_is_complete"
  CHECK (
    ("delegated_provider_id" IS NULL AND cardinality("delegated_scopes") = 0)
    OR
    ("delegated_provider_id" IS NOT NULL AND cardinality("delegated_scopes") > 0)
  );

-- At most one live invitation per (diary, address), the delegation counterpart
-- of `invitations_provider_pending_key`. Re-inviting the same person for the
-- same diary supersedes rather than accumulating, and the supersede in
-- `inviteDelegate` is what keeps this satisfied.
CREATE UNIQUE INDEX "invitations_delegated_diary_pending_key"
  ON "invitations" ("delegated_provider_id", "email")
  WHERE "status" = 'PENDING' AND "delegated_provider_id" IS NOT NULL;
