-- Reverses 20260803114233_service_locations, applied the same day and never
-- released.
--
-- A location is one of the organization's sites and nothing more. Where a
-- service is actually offered is decided by the provider's availability — a
-- working-hours row already names both a location and, through the provider's
-- assignments, the services on offer there — so the service↔location link was a
-- second, weaker answer to a question something else already answers.
--
-- No data migration: the table's only writer was
-- `PUT /v1/locations/:id/services`, removed in the same change, and an empty set
-- meant "offered everywhere", which is what dropping it restores for every row.

-- DropTable
DROP TABLE "service_locations";
