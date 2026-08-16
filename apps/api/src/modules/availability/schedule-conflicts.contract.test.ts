import { describe, expect, it } from "vitest";
import { UncoveredReasons } from "@bam/availability-engine";
import { uncoveredReasonSchema } from "@bam/contracts";

/**
 * The two sides of one enum, kept in step.
 *
 * `@bam/contracts` restates the engine's `UncoveredReasons` as a Zod enum rather
 * than importing it, because that package has no dependency on the engine and is
 * not about to grow one for four string literals. The cost of restating is that
 * the two can drift, and the drift is silent: a reason the engine starts
 * returning would fail response serialization at runtime, on the one screen that
 * exists to explain a problem.
 *
 * This test is the mechanism that makes the restating safe. It lives here rather
 * than in either package because the API is what depends on both — the same
 * arrangement as `notification-engine.contract.test.ts` in `@bam/db`.
 */
describe("uncovered reason contract", () => {
  it("names exactly the reasons the engine can return", () => {
    expect([...uncoveredReasonSchema.options].sort()).toEqual(
      Object.values(UncoveredReasons).sort(),
    );
  });
});
