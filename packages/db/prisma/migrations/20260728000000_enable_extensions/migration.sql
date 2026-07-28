-- Enable the PostgreSQL extensions the schema depends on.
--
-- This is a hand-written migration rather than generated output, because Prisma
-- does not model extensions in a way that survives `migrate diff`. It must run
-- before any migration that uses citext or a gist exclusion constraint.
--
-- btree_gist
--   Required by Epic 4's double-booking prevention. It lets a GiST index mix
--   an equality column with a range column in one EXCLUDE constraint:
--
--     EXCLUDE USING gist (
--       provider_id WITH =,
--       tstzrange(start_at, end_at, '[)') WITH &&
--     ) WHERE (status = 'ACTIVE')
--
--   This is the actual guarantee against overlapping bookings. Application-level
--   checks are advisory only — the predecessor project layered four of them and
--   still relied on a unique constraint to be correct (tech-impl §11.2-11.3).
--
-- citext
--   Case-insensitive text, used for tenant slugs and (from Epic 1) email
--   lookups, so "Sunshine-Dental" and "sunshine-dental" cannot both be
--   registered.

CREATE EXTENSION IF NOT EXISTS "btree_gist";
CREATE EXTENSION IF NOT EXISTS "citext";
