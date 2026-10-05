import {
  attributedName,
  citiesIn,
  clock,
  excerptOf,
  fold,
  hourRanges,
  lines,
  majorUnits,
  minutesOf,
  nameTokens,
  offeredItems,
  personNames,
  prices,
} from "./text.js";
import type {
  FindingCode,
  FindingSeverity,
  KnowledgeFinding,
  KnowledgeRule,
  KnowledgeSnapshot,
  KnowledgeText,
} from "./types.js";

/**
 * Where the business's prose contradicts its records (phase-12 §3.1).
 *
 * Runs on every read rather than on save: most inconsistencies are created by a
 * change *elsewhere* — a provider archived, a service renamed — to a profile
 * nobody touched (phase-12 §1.2.5).
 */
export function checkKnowledge(snapshot: KnowledgeSnapshot): KnowledgeFinding[] {
  const findings: KnowledgeFinding[] = [];
  for (const text of snapshot.texts) {
    if (text.kind !== "SERVICE") findings.push(...unbookableOfferings(snapshot, text));
    findings.push(
      ...people(snapshot, text),
      ...places(snapshot, text),
      ...openingHours(snapshot, text),
      ...unrecordedPrices(snapshot, text),
      ...testimonials(text),
    );
  }
  findings.push(...duplicatedPrices(snapshot), ...missingLocales(snapshot), ...records(snapshot));
  return findings.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "ERROR" ? -1 : 1));
}

function finding(
  code: FindingCode,
  severity: FindingSeverity,
  rule: KnowledgeRule | null,
  text: KnowledgeText | null,
  excerpt: string,
  expected: string[],
  suggestion: string | null = null,
): KnowledgeFinding {
  return {
    code,
    severity,
    rule,
    source: text
      ? { kind: text.kind, id: text.id, name: text.name, locale: text.locale }
      : { kind: "RECORDS", id: null, name: null, locale: null },
    excerpt,
    expected,
    suggestion,
  };
}

/** K1 — a list of offerings naming something that is not a bookable service. */
function unbookableOfferings(snapshot: KnowledgeSnapshot, text: KnowledgeText) {
  const names = snapshot.services.flatMap((service) => service.names.map(fold));
  const expected = snapshot.services.map((service) => service.name);
  return offeredItems(text.text)
    .filter((item) => {
      const folded = fold(item.replace(/\(.*?\)/gu, ""));
      return !names.some((name) => folded.includes(name) || name.includes(folded));
    })
    .map((item) =>
      finding("UNBOOKABLE_SERVICE_MENTIONED", "ERROR", "K1", text, excerptOf(item), expected),
    );
}

/** K2 — a titled name that is not a bookable provider. */
function people(snapshot: KnowledgeSnapshot, text: KnowledgeText) {
  const providers = snapshot.providers.map((provider) => ({
    name: provider.name,
    tokens: nameTokens(provider.name),
  }));
  const expected = snapshot.providers.map((provider) => provider.name);
  const seen = new Set<string>();
  const found: KnowledgeFinding[] = [];
  for (const line of lines(text.text)) {
    for (const name of personNames(line)) {
      const tokens = nameTokens(name);
      const key = tokens.join(" ");
      if (tokens.length === 0 || seen.has(key)) continue;
      seen.add(key);
      if (providers.some((provider) => tokens.every((token) => provider.tokens.includes(token))))
        continue;
      // Same family name, different given name: "Kiss Éva" beside "Kiss Katalin"
      // is far more often a slip than a second doctor.
      const similar = providers.find((provider) =>
        tokens.some((token) => provider.tokens.includes(token)),
      );
      found.push(
        finding(
          "PERSON_NOT_A_PROVIDER",
          "ERROR",
          "K2",
          text,
          name,
          expected,
          similar?.name ?? null,
        ),
      );
    }
  }
  return found;
}

/** K3 — a city that is none of the business's locations. */
function places(snapshot: KnowledgeSnapshot, text: KnowledgeText) {
  const own = new Set(snapshot.locationCities.map(fold));
  const seen = new Set<string>();
  const found: KnowledgeFinding[] = [];
  for (const line of lines(text.text)) {
    for (const city of citiesIn(line)) {
      if (own.has(fold(city)) || seen.has(city)) continue;
      seen.add(city);
      found.push(
        finding(
          "CITY_MISMATCH",
          "ERROR",
          "K3",
          text,
          excerptOf(line),
          snapshot.locationCities,
          city,
        ),
      );
    }
  }
  return found;
}

/** K4 — hours written in prose. Wrong is an error; merely restated is a warning. */
function openingHours(snapshot: KnowledgeSnapshot, text: KnowledgeText) {
  const summary = hoursSummary(snapshot.hours);
  const earliest = Math.min(...snapshot.hours.map((row) => minutesOf(row.startTime)));
  const latest = Math.max(...snapshot.hours.map((row) => minutesOf(row.endTime)));
  const found: KnowledgeFinding[] = [];
  for (const line of lines(text.text)) {
    for (const range of hourRanges(line)) {
      const agrees = snapshot.hours.length > 0 && range.start === earliest && range.end === latest;
      found.push(
        finding(
          agrees ? "HOURS_STATED" : "HOURS_MISMATCH",
          agrees ? "WARNING" : "ERROR",
          "K4",
          text,
          excerptOf(line),
          summary,
        ),
      );
    }
  }
  return found;
}

/** K5 — a price that no bookable service carries. */
function unrecordedPrices(snapshot: KnowledgeSnapshot, text: KnowledgeText) {
  const recorded = servicePrices(snapshot);
  const expected = snapshot.services.map((service) => {
    const price = recorded.find((entry) => entry.id === service.id);
    return price ? `${service.name}: ${price.amount} ${price.currency}` : service.name;
  });
  const found: KnowledgeFinding[] = [];
  for (const line of lines(text.text)) {
    const unmatched = prices(line).some(
      (price) =>
        !recorded.some(
          (entry) => entry.amount === price.amount && entry.currency === price.currency,
        ),
    );
    if (unmatched)
      found.push(finding("PRICE_NOT_RECORDED", "WARNING", "K5", text, excerptOf(line), expected));
  }
  return found;
}

/** K8 — a quotation attributed to a named person. */
function testimonials(text: KnowledgeText) {
  return lines(text.text).flatMap((line) => {
    const name = attributedName(line);
    return name ? [finding("PERSONAL_DATA", "WARNING", "K8", text, name, [])] : [];
  });
}

/** K6 — the same price stated in the profile and in a service's description. */
function duplicatedPrices(snapshot: KnowledgeSnapshot) {
  const found: KnowledgeFinding[] = [];
  const key = (price: { amount: number; currency: string }) => `${price.amount} ${price.currency}`;
  for (const profile of snapshot.texts.filter((text) => text.kind === "PROFILE")) {
    for (const service of snapshot.texts.filter(
      (text) => text.kind === "SERVICE" && text.locale === profile.locale,
    )) {
      const inService = new Set(lines(service.text).flatMap(prices).map(key));
      const line = lines(profile.text).find((candidate) =>
        prices(candidate).some((price) => inService.has(key(price))),
      );
      if (line)
        found.push(
          finding("DUPLICATED_FACT", "WARNING", "K6", profile, excerptOf(line), [
            service.name ?? "",
          ]),
        );
    }
  }
  return found;
}

/** K7 — a language the assistant answers in, missing what the default has. */
function missingLocales(snapshot: KnowledgeSnapshot) {
  const found: KnowledgeFinding[] = [];
  const has = (kind: KnowledgeText["kind"], locale: string) =>
    snapshot.texts.some((text) => text.kind === kind && text.locale === locale);
  const placeholder = (kind: KnowledgeText["kind"], locale: string): KnowledgeText => ({
    kind,
    id: null,
    name: null,
    locale,
    text: "",
  });
  for (const locale of snapshot.supportedLocales) {
    if (locale === snapshot.defaultLocale) continue;
    if (has("PROFILE", snapshot.defaultLocale) && !has("PROFILE", locale))
      found.push(
        finding("LOCALE_MISSING", "WARNING", "K7", placeholder("PROFILE", locale), "", []),
      );
    const untranslated = snapshot.services
      .filter((service) => !service.translatedLocales.includes(locale))
      .map((service) => service.name);
    if (untranslated.length > 0)
      found.push(
        finding(
          "LOCALE_MISSING",
          "WARNING",
          "K7",
          placeholder("SERVICE", locale),
          "",
          untranslated,
        ),
      );
    if (has("FAQ", snapshot.defaultLocale) && !has("FAQ", locale))
      found.push(finding("LOCALE_MISSING", "WARNING", "K7", placeholder("FAQ", locale), "", []));
  }
  return found;
}

/** Not prose, but the reason a correct answer is impossible. */
function records(snapshot: KnowledgeSnapshot) {
  const found: KnowledgeFinding[] = [];
  if (!snapshot.contactEmail && !snapshot.contactPhone)
    found.push(finding("CONTACT_MISSING", "WARNING", null, null, "", []));
  for (const provider of snapshot.providers.filter((entry) => !entry.hasHours)) {
    found.push({
      ...finding("PROVIDER_WITHOUT_HOURS", "WARNING", null, null, provider.name, []),
      source: { kind: "RECORDS", id: provider.id, name: provider.name, locale: null },
    });
  }
  return found;
}

function servicePrices(snapshot: KnowledgeSnapshot) {
  return snapshot.services.flatMap((service) => {
    if (service.priceMinor === null || !service.currency) return [];
    const amount = majorUnits(service.priceMinor, service.currency);
    return amount === null ? [] : [{ id: service.id, amount, currency: service.currency }];
  });
}

const WEEKDAYS = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

/**
 * The practice's bookable week as one line per run of identical days, with
 * providers' periods merged: two dentists 09–13 and 12–17 make 09:00–17:00.
 */
export function hoursSummary(hours: KnowledgeSnapshot["hours"]): string[] {
  const byDay = new Map<number, string>();
  for (let weekday = 1; weekday <= 7; weekday++) {
    const periods = hours
      .filter((row) => row.weekday === weekday)
      .map((row) => [minutesOf(row.startTime), minutesOf(row.endTime)] as [number, number])
      .sort((a, b) => a[0] - b[0]);
    const merged: [number, number][] = [];
    for (const period of periods) {
      const last = merged.at(-1);
      if (last && period[0] <= last[1]) last[1] = Math.max(last[1], period[1]);
      else merged.push([...period]);
    }
    if (merged.length > 0)
      byDay.set(weekday, merged.map(([start, end]) => `${clock(start)}–${clock(end)}`).join(", "));
  }
  const groups: { from: number; to: number; periods: string }[] = [];
  for (const [day, periods] of byDay) {
    const last = groups.at(-1);
    if (last && last.to === day - 1 && last.periods === periods) last.to = day;
    else groups.push({ from: day, to: day, periods });
  }
  return groups.map(
    (group) =>
      `${WEEKDAYS[group.from]}${group.to === group.from ? "" : `–${WEEKDAYS[group.to]}`} ${group.periods}`,
  );
}
