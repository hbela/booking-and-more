-- One live invitation per provider diary.
--
-- The sibling of invitations_tenant_email_pending_key, needed for the same
-- reason at a different angle: that one stops two live invitations reaching the
-- same mailbox, this one stops two reaching the same *diary*.
--
-- Without it, two owners each pressing Invite on Dr. Kovács's row produce two
-- working links, both promising the same schedule. The first acceptance wins and
-- the second violates memberships_provider_id_key from inside the acceptance
-- transaction — a 409 shown to the invitee, caused by something an owner did days
-- earlier and cannot see. This moves the conflict to invite time, where the person
-- who caused it is the person reading the error.
-- docs/phase-9-provider-onboarding.md §2.3.
--
-- Hand-written because Prisma cannot express a partial index. Scoped to PENDING
-- so a revoked or accepted invitation never blocks a reissue.
--
-- Not (tenant_id, provider_id): a provider belongs to exactly one tenant, so the
-- tenant column adds nothing to the constraint. Membership.@@unique([providerId])
-- is unscoped for the same reason.
--
-- `provider_id IS NOT NULL` is redundant for correctness — PostgreSQL already
-- treats NULLs as distinct — but it keeps every generic invitation out of the
-- index, which is most of the table.
CREATE UNIQUE INDEX "invitations_provider_pending_key"
  ON "invitations" ("provider_id")
  WHERE "status" = 'PENDING' AND "provider_id" IS NOT NULL;
