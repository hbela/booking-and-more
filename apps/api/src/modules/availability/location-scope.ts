/**
 * Does a schedule row scoped to `rowLocationId` apply to a question asked about
 * `requested`?
 *
 * The one answer to "which working hours and exceptions count here", shared by
 * the slot search and by the outside-schedule check
 * (docs/phase-3-4-schedule-conflicts.md §2.7). Two copies of this predicate had
 * already drifted apart once: the search read "no location" as "anywhere" for
 * working hours, the check read it as "only rows naming no site", and every
 * booking made from the public page — which never names a location — was
 * flagged as outside a schedule that plainly covered it.
 *
 * - A question about one site: rows naming no site apply everywhere, rows naming
 *   that site apply, rows naming another site do not.
 * - A question about no site in particular: every row applies. A provider is one
 *   person, so a closure booked at any of their sites is time they are not
 *   available, and an opening at any site is time they are.
 *
 * `availabilityRepository.listWorkingHours` expresses the same rule as a Prisma
 * `where`; keep the two in step.
 */
export function appliesAtLocation(
  rowLocationId: string | null,
  requested: string | null | undefined,
): boolean {
  if (requested === null || requested === undefined) return true;
  return rowLocationId === null || rowLocationId === requested;
}
