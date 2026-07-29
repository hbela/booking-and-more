-- Constraints Prisma cannot express, added by hand for the same reason as the
-- invitations partial index: the rule is real, and the schema language is not
-- the place it can live.
--
-- Both of these guard the availability engine's inputs. A malformed time or a
-- backwards interval does not fail where it is written — it fails much later,
-- in the middle of a slot calculation, as an empty result nobody can explain.

-- `HH:mm`, 24-hour. `24:00` is allowed as an end only: a period may run to
-- midnight, but none may start there and mean the end of the day.
ALTER TABLE "working_hours"
  ADD CONSTRAINT "working_hours_start_time_format"
  CHECK ("start_time" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$');

ALTER TABLE "working_hours"
  ADD CONSTRAINT "working_hours_end_time_format"
  CHECK ("end_time" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' OR "end_time" = '24:00');

-- ISO 8601 weekday.
ALTER TABLE "working_hours"
  ADD CONSTRAINT "working_hours_weekday_range"
  CHECK ("weekday" BETWEEN 1 AND 7);

-- A validity window that ends before it begins is never satisfiable, so the
-- row would silently do nothing.
ALTER TABLE "working_hours"
  ADD CONSTRAINT "working_hours_valid_range"
  CHECK ("valid_from" IS NULL OR "valid_until" IS NULL OR "valid_until" >= "valid_from");

-- An exception is a span of real time. Zero-length is refused too: it removes
-- nothing and adds nothing, and is always a mistake in the caller.
ALTER TABLE "availability_exceptions"
  ADD CONSTRAINT "availability_exceptions_range"
  CHECK ("end_at" > "start_at");
