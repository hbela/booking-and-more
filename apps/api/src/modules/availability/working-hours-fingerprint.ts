import { createHash } from "node:crypto";
import { AppError, ErrorCodes } from "@bam/contracts";

/** The fields that make one working period different from another. */
export interface FingerprintableWorkingHours {
  locationId: string | null;
  weekday: number;
  startTime: string;
  endTime: string;
  validFrom: Date | null;
  validUntil: Date | null;
  active: boolean;
}

/**
 * A version marker for a provider's whole week.
 * docs/phase-3-4-diary-delegation.md §2.14.
 *
 * `PUT …/working-hours` replaces the entire set, so a body built from a stale
 * read silently reverts whatever landed in between. The caller echoes back the
 * fingerprint the `GET` gave them, and a mismatch is refused — which is
 * phase-2-3 §2's rule ("a whole-set body may only be built from a whole-set read
 * of that same set") finally enforced by the server rather than trusted to the
 * client.
 *
 * ## Content, not identity
 *
 * The row ids are deliberately **excluded**, even though hashing them would be
 * simpler and would change on every save — `replaceWorkingHours` is a
 * delete-then-insert, so every save mints new ids. Excluding them means two
 * saves that produce an identical week produce an identical fingerprint, and
 * that is the behaviour we want: if somebody saved the same hours you are
 * looking at, there is nothing of theirs for you to revert, and refusing you
 * would be a conflict dialog about nothing.
 *
 * It also makes this survive a writer that does not yet exist. Today
 * `replaceWorkingHours` is the only thing that writes this table; if a partial
 * update is ever added — flipping `active` on one row, say — an id-based
 * fingerprint would not notice it and this one does.
 *
 * ## Why it is sorted here rather than trusted from the query
 *
 * The repository orders by `(weekday, startTime)`, which is not a total order:
 * two periods can share both and differ by location. Sorting the serialised
 * tuples is what makes the digest depend on the *set* rather than on whatever
 * order Postgres happened to return equal keys in — otherwise the same week
 * could fingerprint two different ways and refuse a caller who did nothing
 * wrong.
 *
 * Truncated to 32 hex characters: this is a change detector, not a security
 * boundary. Nothing is authorised by it, and a caller who forges one can only
 * overwrite a diary they already hold the permission to overwrite.
 */
export function fingerprintWorkingHours(rows: FingerprintableWorkingHours[]): string {
  const lines = rows
    .map((row) =>
      [
        row.weekday,
        row.startTime,
        row.endTime,
        row.locationId ?? "",
        // Date-only columns; the time half is always midnight and would only add
        // a way for two equal schedules to serialise differently.
        row.validFrom === null ? "" : row.validFrom.toISOString().slice(0, 10),
        row.validUntil === null ? "" : row.validUntil.toISOString().slice(0, 10),
        row.active ? "1" : "0",
      ].join("|"),
    )
    .sort();

  // The empty week hashes to a constant, which is correct: "this diary has no
  // hours" is one state, and every fresh provider is legitimately in it.
  return createHash("sha256").update(lines.join("\n")).digest("hex").slice(0, 32);
}

/**
 * Pull the fingerprint out of a whole-set schedule body, or refuse.
 *
 * Modelled on `requireIdempotencyKey`, and required for the same kind of reason:
 * a field that is optional "for now" is absent exactly when it matters, because
 * nobody adds a concurrency check until after the save that silently ate
 * somebody's afternoon.
 *
 * Called from the handler **after** the permission check, so a caller who may
 * not touch this diary is told that rather than being sent to look for a field.
 */
export function requireScheduleFingerprint(value: string | undefined): string {
  const fingerprint = value?.trim() ?? "";

  if (fingerprint.length === 0) {
    throw new AppError(
      ErrorCodes.SCHEDULE_FINGERPRINT_REQUIRED,
      "This request must carry `expectedFingerprint` from a current read of this provider's working hours.",
      { statusCode: 400 },
    );
  }

  return fingerprint;
}
