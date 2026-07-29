-- The constraints Prisma cannot express. tech-impl §11.2, §11.3.
--
-- This migration is the one that makes Epic 4's second exit criterion true —
-- "two concurrent users cannot confirm the same exclusive slot". Not the
-- service layer, not a SELECT before an INSERT: those lose the race by
-- construction, because between the check and the write there is a window, and
-- under load somebody is always inside it. PostgreSQL is the only participant
-- that can decide, so it does.
--
-- btree_gist was installed in the Phase 0 migration precisely for this, and
-- packages/db/src/index.test.ts has been rehearsing this constraint shape
-- against a probe table ever since.

-- ---------------------------------------------------------------------------
-- The gate
-- ---------------------------------------------------------------------------

-- One ACTIVE reservation per provider per instant, whether a hold or a booking
-- owns it. That single fact is what stops:
--
--   * two customers confirming the same slot,
--   * a customer confirming a slot another customer is still holding,
--   * two holds on one slot (PRD §9.8: "prevent multiple active holds for the
--     same exclusive capacity"),
--   * staff booking over a customer mid-checkout.
--
-- `provider_id WITH =` rather than `(tenant_id, provider_id)`: a provider id is
-- a cuid belonging to exactly one tenant, so tenant_id would be redundant in
-- the key and would only make the index wider.
--
-- The range is half-open — `'[)'` — so an appointment ending at 10:00 and one
-- starting at 10:00 do not collide. @bam/booking-engine's `spansOverlap` and
-- @bam/availability-engine's interval algebra use the same convention; all
-- three have to agree or every adjacency becomes a one-millisecond argument.
--
-- Note which span goes in here: `start_at`/`end_at` on this table are the
-- *occupied* window, buffers included, not the appointment the customer was
-- told. Two appointments that do not overlap can still have overlapping
-- buffers, and that is a genuine conflict — the provider cannot be cleaning one
-- room and preparing another at once.
ALTER TABLE "capacity_reservations"
  ADD CONSTRAINT "capacity_reservations_no_overlap"
  EXCLUDE USING gist (
    "provider_id" WITH =,
    tstzrange("start_at", "end_at", '[)') WITH &&
  )
  WHERE ("status" = 'ACTIVE');

-- ---------------------------------------------------------------------------
-- The backstop
-- ---------------------------------------------------------------------------

-- tech-impl §11.2 asks for this on `bookings` directly, and §11.3 then refines
-- the design into the reservation table above. Both are kept, because they
-- catch different mistakes.
--
-- The reservation constraint is the operational gate: it covers holds, it
-- covers buffers, and every booking made through the API acquires one. This one
-- guards the case where that does not happen — a data fix, a backfill, an
-- import, a future code path that writes a booking and forgets the reservation.
-- Such a booking would be invisible to the gate above and would silently
-- double-book a provider.
--
-- It is deliberately the weaker of the two: it compares appointment times
-- rather than occupied windows, so it permits pairs the reservation constraint
-- refuses. That asymmetry is intended. A backstop that also encoded buffer
-- policy would have to be migrated every time a service's buffers changed,
-- which is a data change and must never require DDL.
--
-- The status list must agree with BLOCKING_BOOKING_STATUSES in
-- @bam/booking-engine. It is asserted from the test suite rather than trusted,
-- because the two are written in different languages and a disagreement is
-- either a double booking or a slot nobody can ever book.
ALTER TABLE "bookings"
  ADD CONSTRAINT "bookings_no_provider_overlap"
  EXCLUDE USING gist (
    "provider_id" WITH =,
    tstzrange("start_at", "end_at", '[)') WITH &&
  )
  WHERE ("status" IN ('PENDING', 'CONFIRMED'));

-- ---------------------------------------------------------------------------
-- Well-formed spans
--
-- Same reasoning as the availability CHECK constraints: a backwards or
-- zero-length span does not fail where it is written. It fails much later, as a
-- reservation that excludes nothing and a slot that quietly stays bookable
-- after it has been sold.
-- ---------------------------------------------------------------------------

ALTER TABLE "capacity_reservations"
  ADD CONSTRAINT "capacity_reservations_range"
  CHECK ("end_at" > "start_at");

ALTER TABLE "booking_holds"
  ADD CONSTRAINT "booking_holds_range"
  CHECK ("end_at" > "start_at");

ALTER TABLE "bookings"
  ADD CONSTRAINT "bookings_range"
  CHECK ("end_at" > "start_at");

-- A hold that expires before it was created is already dead on arrival, and
-- would sit in the table blocking a slot that nothing will ever release.
ALTER TABLE "booking_holds"
  ADD CONSTRAINT "booking_holds_expiry_after_creation"
  CHECK ("expires_at" > "created_at");

-- ---------------------------------------------------------------------------
-- A reservation must belong to something
-- ---------------------------------------------------------------------------

-- An ownerless ACTIVE reservation is unreachable: nothing links to it, so
-- nothing will ever release it, and it blocks its slot until somebody notices
-- by hand. `hold_id` survives confirmation alongside `booking_id` — it is how a
-- booking's lineage back to the hold that produced it stays readable — so this
-- is "at least one", not "exactly one".
--
-- RELEASED rows are exempt: they block nothing, and a released reservation
-- whose hold was later deleted is harmless history.
ALTER TABLE "capacity_reservations"
  ADD CONSTRAINT "capacity_reservations_have_an_owner"
  CHECK (
    "status" <> 'ACTIVE'
    OR "hold_id" IS NOT NULL
    OR "booking_id" IS NOT NULL
  );

-- A reservation owned by a booking does not time out; one owned only by a hold
-- must. Without this a hold's reservation with a NULL `expires_at` would be
-- immortal — invisible to the sweep, and blocking its slot for good.
ALTER TABLE "capacity_reservations"
  ADD CONSTRAINT "capacity_reservations_hold_expiry"
  CHECK (
    "booking_id" IS NOT NULL
    OR "status" <> 'ACTIVE'
    OR "expires_at" IS NOT NULL
  );

-- ---------------------------------------------------------------------------
-- Money travels in pairs
-- ---------------------------------------------------------------------------

-- A price with no currency is a number nobody can act on; a currency with no
-- price says nothing. The columns are independently nullable because NULL means
-- "not published" rather than "free", so this is the only place the pairing can
-- be enforced. @bam/booking-engine's `buildBookingSnapshot` applies the same
-- rule before the row is ever built; this catches everything that does not go
-- through it.
ALTER TABLE "bookings"
  ADD CONSTRAINT "bookings_price_currency_together"
  CHECK (
    ("price_minor_snapshot" IS NULL AND "currency_snapshot" IS NULL)
    OR ("price_minor_snapshot" IS NOT NULL AND "currency_snapshot" IS NOT NULL)
  );

-- A cancelled booking has to say when. Anything else loses the one fact a
-- dispute turns on, and `updated_at` is not it — a later edit overwrites it.
ALTER TABLE "bookings"
  ADD CONSTRAINT "bookings_cancelled_at_present"
  CHECK ("status" <> 'CANCELLED' OR "cancelled_at" IS NOT NULL);
