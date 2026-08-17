-- One provider writes bookings into at most one calendar.
-- docs/phase-6-google-calendar-part-1.md §3.6.
--
-- Hand-written because Prisma's `@@unique` cannot express a WHERE clause, and a
-- plain unique index over (tenant_id, provider_id) would be wrong twice over: it
-- would forbid a provider ever *reading* busy time from a second calendar
-- (part 2's whole feature), and it would make a disconnected mapping block the
-- reconnection that replaces it.
--
-- The predicate is what makes it a business rule rather than a storage
-- restriction: as many rows as you like, at most one of them writing and active.
-- Deactivate the old one and the new one is legal in the same transaction.
--
-- Why the rule exists at all: `calendar_event_mappings` is keyed
-- (booking_id, calendar_mapping_id), so two writing calendars would mean two
-- events for one appointment and two answers to "where is this booking". A
-- narrowing of tech-impl §10.15, which implies many — reversible by dropping
-- this index alone, since the dispatcher already loops over mappings.
CREATE UNIQUE INDEX "calendar_mappings_one_write_calendar_per_provider"
    ON "calendar_mappings" ("tenant_id", "provider_id")
    WHERE ("write_bookings" = true AND "active" = true);
