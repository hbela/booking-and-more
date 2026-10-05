/**
 * Reading prose without understanding it.
 *
 * Every extractor here works line by line on the original text and reports the
 * original line, so an owner sees their own words rather than a normalised
 * form. They are deliberately narrow — anchored on a title, a unit, a currency —
 * because a false positive costs an owner's trust in the whole list, and the
 * model-assisted audit (phase-12 §3.2) exists for what these cannot see.
 */

/** Case-, accent- and punctuation-insensitive: "Szentendrén" → "szentendren". */
export function fold(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export function lines(text: string): string[] {
  return text.split(/\r?\n/u);
}

export function excerptOf(line: string): string {
  const trimmed = line.trim();
  return trimmed.length > 200 ? `${trimmed.slice(0, 197)}…` : trimmed;
}

// --- People -------------------------------------------------------------------

const NAME_WORD = String.raw`\p{Lu}[\p{Ll}'’-]+`;
const NAME = String.raw`(${NAME_WORD}(?:\s+${NAME_WORD}){0,2})`;
const TITLE_BEFORE = new RegExp(String.raw`(?<!\p{L})(?:Dr|dr|Prof|prof)\.?\s+${NAME}`, "gu");
const TITLE_AFTER = new RegExp(
  String.raw`${NAME}\s+(?:doktornő|doktor|főorvos|szakorvos|fogorvos|fogorvosnő)\p{Ll}*`,
  "gu",
);

/** Names written with a title: "Dr. Kocsis Zoltán", "Kiss Éva doktornő". */
export function personNames(line: string): string[] {
  const names = [
    ...[...line.matchAll(TITLE_BEFORE)].map((match) => match[1]!),
    ...[...line.matchAll(TITLE_AFTER)].map((match) => match[1]!),
  ];
  return [...new Set(names.map((name) => name.trim()))];
}

const TITLE_WORDS = new Set(["dr", "prof", "phd", "md", "dmd"]);

export function nameTokens(name: string): string[] {
  return fold(name)
    .split(" ")
    .filter((token) => token && !TITLE_WORDS.has(token));
}

// --- Places -------------------------------------------------------------------

/**
 * Towns a Hungarian business plausibly names, plus the neighbours' capitals.
 * Not a gazetteer and not trying to be one: a city missing here is a city this
 * check is silent about, which is the safe direction.
 */
export const KNOWN_CITIES = [
  "Budapest",
  "Debrecen",
  "Szeged",
  "Miskolc",
  "Pécs",
  "Győr",
  "Nyíregyháza",
  "Kecskemét",
  "Székesfehérvár",
  "Szombathely",
  "Szolnok",
  "Érd",
  "Tatabánya",
  "Kaposvár",
  "Sopron",
  "Veszprém",
  "Békéscsaba",
  "Zalaegerszeg",
  "Eger",
  "Nagykanizsa",
  "Dunaújváros",
  "Hódmezővásárhely",
  "Szentendre",
  "Gödöllő",
  "Vác",
  "Budaörs",
  "Dunakeszi",
  "Szigetszentmiklós",
  "Esztergom",
  "Siófok",
  "Keszthely",
  "Pomáz",
  "Budakeszi",
  "Göd",
  "Visegrád",
  "Leányfalu",
  "Piliscsaba",
  "Solymár",
  "Üröm",
  "Vienna",
  "Wien",
  "Bécs",
  "Bratislava",
  "Pozsony",
  "Berlin",
  "München",
  "Munich",
  "Paris",
  "Párizs",
  "London",
] as const;

/**
 * Hungarian case endings and the adjectival -i ("budapesti", "Szentendrén",
 * "Győrben"), after folding. A whitelist rather than "any letters", so "Vác"
 * does not match "vacsora" and "Pécs" does not match "pecsét".
 */
const CITY_SUFFIX = String.raw`(?:i\p{L}*|n|en|on|ön|ban|ben|ba|be|ra|re|rol|tol|hoz|hez|bol|ig|nal|nel|ert)?`;

/** Known cities named on this line, as written in the list above. */
export function citiesIn(line: string): string[] {
  const folded = fold(line);
  return KNOWN_CITIES.filter((city) =>
    new RegExp(String.raw`(?<!\p{L})${fold(city)}${CITY_SUFFIX}(?!\p{L})`, "u").test(folded),
  );
}

// --- Hours --------------------------------------------------------------------

const HOUR_RANGE = new RegExp(
  String.raw`(?<![\d.,:])(\d{1,2})(?:[:.](\d{2}))?\s*(óra\p{Ll}*|h|uhr)?\s*(?:-|–|—|és|to|bis|à|until)\s*(\d{1,2})(?:[:.](\d{2}))?\s*(óra\p{Ll}*|h|uhr|am|pm)?(?![\d\p{L}])`,
  "giu",
);

/**
 * Opening-hours ranges, in minutes since midnight: "8 és 20 óra között",
 * "09:00–17:00", "9h-17h". A bare "3-5" is not a time — at least one side
 * must carry minutes or a unit — which is what keeps "3-5 alkalom" out.
 */
export function hourRanges(line: string): { start: number; end: number }[] {
  const ranges: { start: number; end: number }[] = [];
  for (const match of line.matchAll(HOUR_RANGE)) {
    const [, h1, m1, unit1, h2, m2, unit2] = match;
    if (m1 === undefined && m2 === undefined && !unit1 && !unit2) continue;
    const start = Number(h1) * 60 + Number(m1 ?? 0);
    const end = Number(h2) * 60 + Number(m2 ?? 0);
    if (Number(h1) > 24 || Number(h2) > 24 || start >= end) continue;
    ranges.push({ start, end });
  }
  return ranges;
}

export function clock(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

export function minutesOf(time: string): number {
  const [hours, minutes] = time.split(":");
  return Number(hours) * 60 + Number(minutes);
}

// --- Money --------------------------------------------------------------------

// Thousands separators: space, dot, no-break space, narrow no-break space.
const THOUSANDS = `[ .${String.fromCharCode(0xa0, 0x202f)}]`;
const AMOUNT = String.raw`(\d{1,3}(?:${THOUSANDS}\d{3})+|\d+)(?:,(\d{1,2}))?`;
const PRICE_AFTER = new RegExp(
  String.raw`(?<![\d.,])${AMOUNT}\s*(Ft|HUF|forint|EUR|€|USD|\$)(?!\p{L})`,
  "giu",
);
const PRICE_BEFORE = new RegExp(String.raw`(€|\$)\s?${AMOUNT}(?![\d])`, "gu");

const CURRENCY: Record<string, string> = {
  ft: "HUF",
  huf: "HUF",
  forint: "HUF",
  eur: "EUR",
  "€": "EUR",
  usd: "USD",
  $: "USD",
};

/** Amounts in major units with their ISO currency: "31.000 Ft" → 31000 HUF. */
export function prices(line: string): { amount: number; currency: string }[] {
  const parse = (whole: string, fraction: string | undefined) =>
    Number(whole.replace(new RegExp(THOUSANDS, "gu"), "")) +
    (fraction ? Number(`0.${fraction}`) : 0);
  return [
    ...[...line.matchAll(PRICE_AFTER)].map((match) => ({
      amount: parse(match[1]!, match[2]),
      currency: CURRENCY[match[3]!.toLowerCase()]!,
    })),
    ...[...line.matchAll(PRICE_BEFORE)].map((match) => ({
      amount: parse(match[2]!, match[3]),
      currency: CURRENCY[match[1]!]!,
    })),
  ];
}

/** Intl decides the minor unit — HUF and EUR differ, and guessing is how prices go wrong. */
export function majorUnits(minor: number, currency: string): number | null {
  try {
    const digits =
      new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions()
        .maximumFractionDigits ?? 2;
    return minor / 10 ** digits;
  } catch {
    return null;
  }
}

// --- Lists and testimonials ---------------------------------------------------

const OFFERING_HEADINGS = [
  "szolgaltatas",
  "kezelese",
  "kezeles",
  "services",
  "treatments",
  "what we offer",
  "leistungen",
  "behandlungen",
  "prestations",
  "soins",
];

const BULLET = /^\s*(?:[-*•–]|\d+[.)])\s+(.+)$/u;

/**
 * Items of any bulleted list under a heading that announces what the business
 * offers ("## Szolgáltatásaink", "Our services:").
 */
export function offeredItems(text: string): string[] {
  const items: string[] = [];
  const all = lines(text);
  for (let index = 0; index < all.length; index++) {
    const line = all[index]!.trim();
    const isHeading = /^#{1,6}\s/u.test(line) || line.endsWith(":") || /^\*\*.+\*\*$/u.test(line);
    const heading = fold(line);
    if (!isHeading || !OFFERING_HEADINGS.some((word) => heading.includes(word))) continue;
    let next = index + 1;
    while (next < all.length && all[next]!.trim() === "") next++;
    for (; next < all.length; next++) {
      const bullet = BULLET.exec(all[next]!);
      if (!bullet) break;
      items.push(bullet[1]!.replace(/\*\*/gu, "").trim());
    }
  }
  return items;
}

const ATTRIBUTION = new RegExp(
  String.raw`["”“»"]\s*[-–—]\s*(${NAME_WORD}(?:\s+${NAME_WORD}){1,2})\s*$`,
  "u",
);

/** "„…" – Karos Ágnes": a quotation attributed to a named person. */
export function attributedName(line: string): string | null {
  return ATTRIBUTION.exec(line.trim())?.[1] ?? null;
}
