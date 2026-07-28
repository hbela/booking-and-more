-- One live invitation per email per tenant.
--
-- Hand-written because Prisma cannot express a partial index. A plain
-- @@unique([tenantId, email]) would be wrong: once an invitation is revoked or
-- expires, that address could never be invited again.
--
-- Scoped to PENDING only, so revoking and re-inviting works, while a double
-- submit or a race between two admins cannot create two live invitations that
-- both grant access.
CREATE UNIQUE INDEX "invitations_tenant_email_pending_key"
  ON "invitations" ("tenant_id", "email")
  WHERE "status" = 'PENDING';
