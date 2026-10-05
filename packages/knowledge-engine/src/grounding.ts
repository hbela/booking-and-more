import { hoursSummary } from "./checks.js";
import {
  citiesIn,
  clock,
  fold,
  hourRanges,
  lines,
  majorUnits,
  minutesOf,
  nameTokens,
  personNames,
  prices,
} from "./text.js";
import type { KnowledgeSnapshot } from "./types.js";

/**
 * Whether an answer the model wrote states something the records do not
 * (phase-12 §4.5). The same narrow extractors as the check, pointed at the
 * assistant's own prose: a titled name that is no bookable provider, a city
 * that is no location, hours outside the bookable week, a price no service
 * carries.
 *
 * Flag, never block (§8.2): a false positive on a live customer costs more than
 * a flagged transcript, and these extractors are tuned to miss rather than to
 * over-report.
 */

export type GroundingKind = "PERSON" | "CITY" | "HOURS" | "PRICE";

export interface GroundingIssue {
  kind: GroundingKind;
  /** As the answer wrote it, or normalised ("09:00–20:00", "31000 HUF"). */
  value: string;
}

export type GroundingFacts = Pick<
  KnowledgeSnapshot,
  "services" | "providers" | "locationCities" | "hours"
> & {
  /** Named, not bookable, acknowledged by the owner (§3.3) — may be mentioned. */
  acknowledgedPeople: string[];
};

export function groundingIssues(answer: string, facts: GroundingFacts): GroundingIssue[] {
  const issues: GroundingIssue[] = [];
  const add = (issue: GroundingIssue) => {
    if (!issues.some((entry) => entry.kind === issue.kind && entry.value === issue.value))
      issues.push(issue);
  };

  const people = [...facts.providers.map((provider) => provider.name), ...facts.acknowledgedPeople]
    .map(nameTokens)
    .filter((tokens) => tokens.length > 0);
  const cities = new Set(facts.locationCities.map(fold));
  const allowedHours = bookableRanges(facts.hours);
  const recordedPrices = facts.services.flatMap((service) => {
    if (service.priceMinor === null || !service.currency) return [];
    const amount = majorUnits(service.priceMinor, service.currency);
    return amount === null ? [] : [`${String(amount)} ${service.currency}`];
  });

  for (const line of lines(answer)) {
    for (const name of personNames(line)) {
      const tokens = nameTokens(name);
      if (!people.some((known) => tokens.every((token) => known.includes(token))))
        add({ kind: "PERSON", value: name });
    }
    for (const city of citiesIn(line)) {
      if (!cities.has(fold(city))) add({ kind: "CITY", value: city });
    }
    for (const range of hourRanges(line)) {
      const value = `${clock(range.start)}–${clock(range.end)}`;
      if (!allowedHours.has(value)) add({ kind: "HOURS", value });
    }
    for (const price of prices(line)) {
      const value = `${String(price.amount)} ${price.currency}`;
      if (!recordedPrices.includes(value)) add({ kind: "PRICE", value });
    }
  }
  return issues;
}

/**
 * Every range an honest answer about hours could state: each day's merged
 * periods, and the week's earliest-to-latest span ("we are open 9 to 17").
 */
function bookableRanges(hours: KnowledgeSnapshot["hours"]): Set<string> {
  const ranges = new Set<string>();
  for (const line of hoursSummary(hours)) {
    for (const match of line.matchAll(/(\d{2}:\d{2})–(\d{2}:\d{2})/gu)) ranges.add(match[0]);
  }
  if (hours.length > 0) {
    const earliest = Math.min(...hours.map((row) => minutesOf(row.startTime)));
    const latest = Math.max(...hours.map((row) => minutesOf(row.endTime)));
    ranges.add(`${clock(earliest)}–${clock(latest)}`);
  }
  return ranges;
}
