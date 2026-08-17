-- Nothing regresses on day one. phase-3-4-diary-delegation §2.2.
--
-- Yesterday every ASSISTANT held `booking:read:all` and `booking:manage:all`;
-- today the role holds neither. Without this, deploying takes every front desk
-- in every organization off every diary at once, and the first anybody hears of
-- it is a receptionist who cannot open the morning's list.
--
-- BOOKINGS only, and this is the load-bearing line: an ASSISTANT never held
-- `availability:manage:all`, so granting AVAILABILITY here would *widen* access
-- under cover of a compatibility backfill — invisible in a diff titled "no
-- behaviour change". A backfill may reproduce yesterday exactly; it may never
-- round up.
--
-- A separate file from the DDL so that migration stays byte-identical to what
-- Prisma generated and is diffable by eye, and so this data change can be read,
-- re-run and reverted on its own. `ON CONFLICT DO NOTHING` makes it idempotent.
INSERT INTO "provider_delegations" (
    "id",
    "tenant_id",
    "provider_id",
    "membership_id",
    "scopes",
    "granted_by_user_id",
    "granted_at",
    "updated_at"
)
SELECT
    -- Not a cuid2: the column is TEXT and nothing parses it, and the different
    -- shape plus the NULL granter below makes a backfilled row identifiable at
    -- a glance.
    gen_random_uuid()::text,
    p."tenant_id",
    p."id",
    m."id",
    ARRAY['BOOKINGS']::"delegation_scope"[],
    NULL,                       -- the platform granted these, not a person
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM "providers" p
JOIN "memberships" m
       ON m."tenant_id" = p."tenant_id"
      AND m."role"      = 'ASSISTANT'
      AND m."status"    = 'ACTIVE'
-- Archived diaries take no new bookings, and a grant manufactured here would sit
-- on every Delegates panel forever. Note the deliberate asymmetry with §2.8: an
-- *existing* grant survives archiving. This only declines to invent one.
WHERE p."archived_at" IS NULL
  -- The membership that *is* this diary already holds the `:own` permissions. A
  -- grant would add nothing and would later be misread as the source of that
  -- access.
  AND (m."provider_id" IS NULL OR m."provider_id" <> p."id")
ON CONFLICT ("provider_id", "membership_id") DO NOTHING;
