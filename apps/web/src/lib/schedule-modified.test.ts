import { describe, expect, it } from "vitest";
import { ErrorCodes } from "@bam/contracts";
import { ApiError } from "./api-client";
import { scheduleModifiedBy } from "./schedule-modified";

function refusal(details: unknown): ApiError {
  return new ApiError("changed", ErrorCodes.SCHEDULE_MODIFIED, 409, undefined, details);
}

describe("scheduleModifiedBy", () => {
  it("returns the editor named by the refusal", () => {
    expect(
      scheduleModifiedBy(
        refusal({
          currentFingerprint: "abc",
          lastChange: { at: "2026-08-18T10:00:00.000Z", by: { userId: "u1", name: "Réka" } },
        }),
      ),
    ).toEqual({ at: "2026-08-18T10:00:00.000Z", by: { userId: "u1", name: "Réka" } });
  });

  it("distinguishes 'not this error' from 'this error, nobody to name'", () => {
    // undefined lets the caller fall through to its ordinary message; null is
    // still a refusal and must still stop the save.
    expect(scheduleModifiedBy(new Error("network"))).toBeUndefined();
    expect(
      scheduleModifiedBy(
        new ApiError("x", ErrorCodes.SCHEDULE_CONFLICTS_BOOKINGS, 409, undefined, {}),
      ),
    ).toBeUndefined();

    expect(scheduleModifiedBy(refusal(null))).toBeNull();
    expect(scheduleModifiedBy(refusal({ currentFingerprint: "abc" }))).toBeNull();
  });

  it("keeps the refusal when the trail has not caught up", () => {
    // The audit write is fire-and-forget, so a conflict found milliseconds after
    // the other save legitimately has no actor yet (§2.14.2).
    expect(
      scheduleModifiedBy(refusal({ lastChange: { at: "2026-08-18T10:00:00.000Z", by: null } })),
    ).toEqual({ at: "2026-08-18T10:00:00.000Z", by: null });
  });

  it("drops a malformed actor rather than the whole payload", () => {
    expect(
      scheduleModifiedBy(
        refusal({ lastChange: { at: "2026-08-18T10:00:00.000Z", by: { userId: 7 } } }),
      ),
    ).toEqual({ at: "2026-08-18T10:00:00.000Z", by: null });
  });
});
