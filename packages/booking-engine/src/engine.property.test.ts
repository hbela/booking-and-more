import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { generateSlots, type AvailabilityQuery } from "@bam/availability-engine";
import { effectiveHoldStatus, holdRemainingSeconds } from "./holds.js";
import { mostRestrictiveAdvance, mostRestrictiveNotice } from "./policy.js";
import { occupiedSpanFor, parseInstant, spansOverlap, toInstant } from "./spans.js";
import { allowedTransitionsFrom, checkTransition, isTerminal } from "./transitions.js";
import { BookingStatuses, HoldStatuses, type BookingStatus } from "./types.js";

/**
 * Property tests. tech-impl §39.2.
 *
 * The first block is the important one: it is the only place the two engines
 * are checked against each other, and the invariant it asserts — that a booked
 * slot removes exactly itself from the next search — is what stands between
 * this system and double bookings.
 */

const ALL_STATUSES: BookingStatus[] = Object.values(BookingStatuses);

const arbInstant = fc
  .integer({ min: Date.UTC(2026, 0, 1), max: Date.UTC(2027, 0, 1) })
  // Whole seconds: the wire format carries milliseconds but no real schedule
  // does, and sub-second noise only obscures what a failure means.
  .map((ms) => toInstant(ms - (ms % 1000)));

// ---------------------------------------------------------------------------
// The two engines must agree about what a booking occupies
// ---------------------------------------------------------------------------

const arbSlotQuery = fc
  .record({
    durationMinutes: fc.integer({ min: 5, max: 120 }),
    bufferBeforeMinutes: fc.integer({ min: 0, max: 30 }),
    bufferAfterMinutes: fc.integer({ min: 0, max: 30 }),
    slotIntervalMinutes: fc.constantFrom(5, 10, 15, 20, 30, 60),
    timezone: fc.constantFrom(
      "Europe/Budapest",
      "UTC",
      "America/New_York",
      "Australia/Lord_Howe",
      "Asia/Kolkata",
      "Pacific/Chatham",
    ),
    weekday: fc.integer({ min: 1, max: 7 }),
  })
  .map((input): AvailabilityQuery => ({
    providerId: "provider_1",
    serviceDurationMinutes: input.durationMinutes,
    bufferBeforeMinutes: input.bufferBeforeMinutes,
    bufferAfterMinutes: input.bufferAfterMinutes,
    dateFrom: "2026-08-03",
    dateTo: "2026-08-09",
    timezone: input.timezone,
    slotIntervalMinutes: input.slotIntervalMinutes,
    workingPeriods: [{ weekday: input.weekday, startTime: "09:00", endTime: "17:00" }],
    additionalPeriods: [],
    unavailablePeriods: [],
    bookings: [],
    activeHolds: [],
    externalBusyPeriods: [],
    minimumNoticeMinutes: 0,
    maximumAdvanceDays: 365,
    now: "2026-07-01T00:00:00.000Z",
  }));

describe("the booking engine and the availability engine agree", () => {
  it("computes the same diary block the slot search reported", () => {
    // If these two ever disagree, a booking either blocks more time than the
    // search believed (phantom gaps) or less (double booking). Both engines
    // must derive the occupied window from the same arithmetic; this asserts
    // they actually do.
    fc.assert(
      fc.property(arbSlotQuery, (query) => {
        for (const slot of generateSlots(query)) {
          const span = occupiedSpanFor({
            startAt: slot.startAt,
            durationMinutes: query.serviceDurationMinutes,
            bufferBeforeMinutes: query.bufferBeforeMinutes,
            bufferAfterMinutes: query.bufferAfterMinutes,
          });

          expect(span.appointment.startAt).toBe(slot.startAt);
          expect(span.appointment.endAt).toBe(slot.endAt);
          expect(span.occupied.startAt).toBe(slot.occupiedFrom);
          expect(span.occupied.endAt).toBe(slot.occupiedUntil);
        }
      }),
      { numRuns: 200 },
    );
  });

  it("removes exactly the booked slot and nothing else from the next search", () => {
    // Book the middle slot, search again, and assert two things at once: no
    // remaining slot collides with what was booked, and every slot that did not
    // collide survived. The first half is the anti-double-booking guarantee;
    // the second stops an over-broad reservation quietly eating a provider's
    // day.
    fc.assert(
      fc.property(arbSlotQuery, (query) => {
        const before = generateSlots(query);
        if (before.length < 3) return;

        const chosen = before[Math.floor(before.length / 2)]!;
        const booked = occupiedSpanFor({
          startAt: chosen.startAt,
          durationMinutes: query.serviceDurationMinutes,
          bufferBeforeMinutes: query.bufferBeforeMinutes,
          bufferAfterMinutes: query.bufferAfterMinutes,
        });

        const after = generateSlots({ ...query, bookings: [booked.occupied] });

        for (const slot of after) {
          expect(
            spansOverlap(
              { startAt: slot.occupiedFrom, endAt: slot.occupiedUntil },
              booked.occupied,
            ),
          ).toBe(false);
        }

        const survivors = new Set(after.map((slot) => slot.startAt));
        for (const slot of before) {
          const collides = spansOverlap(
            { startAt: slot.occupiedFrom, endAt: slot.occupiedUntil },
            booked.occupied,
          );
          expect(survivors.has(slot.startAt)).toBe(!collides);
        }
      }),
      { numRuns: 150 },
    );
  });
});

// ---------------------------------------------------------------------------
// Spans
// ---------------------------------------------------------------------------

describe("span properties", () => {
  const arbSpanInput = fc.record({
    startAt: arbInstant,
    durationMinutes: fc.integer({ min: 1, max: 480 }),
    bufferBeforeMinutes: fc.integer({ min: 0, max: 120 }),
    bufferAfterMinutes: fc.integer({ min: 0, max: 120 }),
  });

  it("always encloses the appointment in the diary block", () => {
    fc.assert(
      fc.property(arbSpanInput, (input) => {
        const { appointment, occupied } = occupiedSpanFor(input);

        expect(parseInstant(occupied.startAt)).toBeLessThanOrEqual(
          parseInstant(appointment.startAt),
        );
        expect(parseInstant(occupied.endAt)).toBeGreaterThanOrEqual(
          parseInstant(appointment.endAt),
        );
      }),
    );
  });

  it("is deterministic", () => {
    fc.assert(
      fc.property(arbSpanInput, (input) => {
        expect(occupiedSpanFor(input)).toEqual(occupiedSpanFor(input));
      }),
    );
  });

  it("grows the block by exactly the buffers", () => {
    fc.assert(
      fc.property(arbSpanInput, (input) => {
        const { appointment, occupied } = occupiedSpanFor(input);

        expect(parseInstant(appointment.startAt) - parseInstant(occupied.startAt)).toBe(
          input.bufferBeforeMinutes * 60_000,
        );
        expect(parseInstant(occupied.endAt) - parseInstant(appointment.endAt)).toBe(
          input.bufferAfterMinutes * 60_000,
        );
      }),
    );
  });

  it("overlaps symmetrically", () => {
    const arbSpan = fc
      .tuple(arbInstant, fc.integer({ min: 1, max: 480 }))
      .map(([startAt, minutes]) => ({
        startAt,
        endAt: toInstant(parseInstant(startAt) + minutes * 60_000),
      }));

    fc.assert(
      fc.property(arbSpan, arbSpan, (left, right) => {
        expect(spansOverlap(left, right)).toBe(spansOverlap(right, left));
      }),
    );
  });

  it("never reports a span as overlapping the one that starts where it ends", () => {
    fc.assert(
      fc.property(
        arbInstant,
        fc.integer({ min: 1, max: 480 }),
        fc.integer({ min: 1, max: 480 }),
        (startAt, first, second) => {
          const boundary = parseInstant(startAt) + first * 60_000;

          expect(
            spansOverlap(
              { startAt, endAt: toInstant(boundary) },
              { startAt: toInstant(boundary), endAt: toInstant(boundary + second * 60_000) },
            ),
          ).toBe(false);
        },
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// The state machine
// ---------------------------------------------------------------------------

describe("state machine properties", () => {
  const arbStatus = fc.constantFrom(...ALL_STATUSES);

  it("lets nothing out of a terminal status", () => {
    fc.assert(
      fc.property(arbStatus, arbStatus, (from, to) => {
        if (!isTerminal(from)) return;
        expect(checkTransition(from, to).allowed).toBe(false);
      }),
    );
  });

  it("never allows a status to transition to itself", () => {
    fc.assert(
      fc.property(arbStatus, (status) => {
        expect(checkTransition(status, status).allowed).toBe(false);
      }),
    );
  });

  it("allows exactly the transitions the table lists", () => {
    fc.assert(
      fc.property(arbStatus, arbStatus, (from, to) => {
        expect(checkTransition(from, to).allowed).toBe(
          from !== to && allowedTransitionsFrom(from).includes(to),
        );
      }),
    );
  });

  it("terminates: every path reaches a terminal status", () => {
    // Guards against someone adding a cycle — CONFIRMED → PENDING → CONFIRMED
    // would let a booking bounce forever and never settle into history.
    for (const start of ALL_STATUSES) {
      let current: BookingStatus = start;
      const visited = new Set<BookingStatus>([current]);

      while (!isTerminal(current)) {
        const next = allowedTransitionsFrom(current)[0]!;
        expect(visited.has(next)).toBe(false);
        visited.add(next);
        current = next;
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Holds
// ---------------------------------------------------------------------------

describe("hold properties", () => {
  it("never un-expires: once past the deadline, always past it", () => {
    fc.assert(
      fc.property(
        arbInstant,
        fc.integer({ min: 1, max: 60 }),
        fc.integer({ min: 0, max: 7200 }),
        (createdAt, minutes, elapsed) => {
          const expiresAt = toInstant(parseInstant(createdAt) + minutes * 60_000);
          const hold = { status: HoldStatuses.ACTIVE, expiresAt };

          const at = toInstant(parseInstant(createdAt) + elapsed * 1000);
          const later = toInstant(parseInstant(at) + 1000);

          if (effectiveHoldStatus(hold, at) === HoldStatuses.EXPIRED) {
            expect(effectiveHoldStatus(hold, later)).toBe(HoldStatuses.EXPIRED);
          }
        },
      ),
    );
  });

  it("counts down monotonically and never below zero", () => {
    fc.assert(
      fc.property(
        arbInstant,
        fc.integer({ min: 1, max: 60 }),
        fc.integer({ min: 0, max: 7200 }),
        (createdAt, minutes, elapsed) => {
          const expiresAt = toInstant(parseInstant(createdAt) + minutes * 60_000);
          const at = toInstant(parseInstant(createdAt) + elapsed * 1000);
          const later = toInstant(parseInstant(at) + 1000);

          const now = holdRemainingSeconds({ expiresAt }, at);
          const then = holdRemainingSeconds({ expiresAt }, later);

          expect(now).toBeGreaterThanOrEqual(0);
          expect(then).toBeLessThanOrEqual(now);
        },
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// Inheritance
// ---------------------------------------------------------------------------

describe("inheritance properties", () => {
  const arbValues = fc.array(fc.option(fc.integer({ min: 0, max: 10_000 }), { nil: null }), {
    maxLength: 4,
  });

  it("only ever tightens: adding a constraint cannot loosen the result", () => {
    fc.assert(
      fc.property(arbValues, fc.integer({ min: 0, max: 10_000 }), (values, extra) => {
        expect(mostRestrictiveNotice([...values, extra], 0)).toBeGreaterThanOrEqual(
          mostRestrictiveNotice(values, 0),
        );
        expect(mostRestrictiveAdvance([...values, extra], 10_000)).toBeLessThanOrEqual(
          mostRestrictiveAdvance(values, 10_000),
        );
      }),
    );
  });

  it("ignores NULLs entirely", () => {
    fc.assert(
      fc.property(arbValues, (values) => {
        expect(mostRestrictiveNotice([...values, null], 0)).toBe(mostRestrictiveNotice(values, 0));
        expect(mostRestrictiveAdvance([...values, null], 180)).toBe(
          mostRestrictiveAdvance(values, 180),
        );
      }),
    );
  });
});
