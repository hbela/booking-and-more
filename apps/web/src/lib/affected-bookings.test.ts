import { describe, expect, it } from "vitest";
import { ErrorCodes } from "@bam/contracts";
import { affectedBookingsOf } from "./affected-bookings";
import { ApiError } from "./api-client";

/**
 * docs/phase-3-4-schedule-conflicts.md §2.4, from the client's side.
 *
 * This is a narrowing of `unknown` that decides whether a dialog opens, so its
 * failure modes are worth naming: opening on the wrong error would ask the owner
 * to confirm something unrelated, and failing to open on the right one would
 * turn "the server is asking" into "the save did not work".
 */

const entry = {
  id: "bk_1",
  reference: "BK-4C7A",
  startAt: "2026-09-07T08:00:00.000Z",
  endAt: "2026-09-07T09:00:00.000Z",
  providerId: "prv_1",
  providerName: "Dr. Kiss Anna",
  serviceName: "Fogtisztítás",
  customerName: "Nagy Béla",
  reason: "OUTSIDE_WORKING_HOURS",
};

function refusal(details: unknown): ApiError {
  return new ApiError(
    "This change leaves 1 existing booking outside the schedule.",
    ErrorCodes.SCHEDULE_CONFLICTS_BOOKINGS,
    409,
    "req_1",
    details,
  );
}

describe("affectedBookingsOf", () => {
  it("returns the list the refusal carried", () => {
    expect(affectedBookingsOf(refusal({ affectedBookings: [entry] }))).toEqual([entry]);
  });

  it("ignores an error with a different code", () => {
    const other = new ApiError("Taken.", ErrorCodes.SLOT_NO_LONGER_AVAILABLE, 409, "req_2", {
      affectedBookings: [entry],
    });

    expect(affectedBookingsOf(other)).toBeNull();
  });

  it("ignores anything that is not an ApiError", () => {
    expect(affectedBookingsOf(new Error("network down"))).toBeNull();
    expect(affectedBookingsOf(undefined)).toBeNull();
  });

  it("treats a refusal with no usable entries as not this error", () => {
    // Rather than opening a dialog that asks about nothing. The caller falls
    // through to its ordinary error message, which is the honest outcome.
    expect(affectedBookingsOf(refusal({ affectedBookings: [] }))).toBeNull();
    expect(affectedBookingsOf(refusal({}))).toBeNull();
    expect(affectedBookingsOf(refusal(null))).toBeNull();
  });

  it("drops an entry it cannot render rather than rendering undefined", () => {
    const found = affectedBookingsOf(
      refusal({ affectedBookings: [entry, { id: "bk_2" }, { ...entry, reason: "SOMETHING_NEW" }] }),
    );

    expect(found).toEqual([entry]);
  });
});
