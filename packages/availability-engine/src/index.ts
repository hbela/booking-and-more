/**
 * @bam/availability-engine — pure slot generation. tech-impl §13.
 *
 * This package has **no runtime dependencies**, and that is a design
 * constraint rather than an accident of it being small. It must not import
 * Fastify, Prisma, Redis or any external API, so that the hardest arithmetic in
 * the product — schedules across daylight-saving transitions — can be tested as
 * a function rather than through a stack (CLAUDE.md rule 8).
 *
 * The caller loads the data and applies policy; the engine only computes.
 */

export { generateSlots, hasAvailability } from "./engine.js";
export { clamp, contains, normalize, subtract, totalDuration } from "./intervals.js";
export type {
  AvailabilityQuery,
  AvailableSlot,
  DateTimePeriod,
  Interval,
  TimePeriod,
} from "./types.js";
export {
  addDays,
  dateOnlyAt,
  eachDate,
  formatDateOnly,
  isValidTimeZone,
  offsetAt,
  parseDateOnly,
  parseTimeOfDay,
  resolveWallClock,
  toWallClock,
  wallClockToEpochMs,
  weekdayOf,
} from "./zone.js";
export type { DateOnly, ResolvedWallClock, WallClock, WallClockResolution } from "./zone.js";
