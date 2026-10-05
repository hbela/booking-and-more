/**
 * What the consistency checks read and what they report (phase-12 §3).
 *
 * The snapshot is plain values: the API loads it, this package judges it. A
 * finding names the rule from phase-12 §2.2 it enforces, so the screen that
 * shows it can say *why* as well as *what*.
 */

export type FindingSeverity = "ERROR" | "WARNING";

export type FindingCode =
  | "UNBOOKABLE_SERVICE_MENTIONED"
  | "PERSON_NOT_A_PROVIDER"
  | "CITY_MISMATCH"
  | "HOURS_MISMATCH"
  | "HOURS_STATED"
  | "PRICE_NOT_RECORDED"
  | "DUPLICATED_FACT"
  | "LOCALE_MISSING"
  | "PERSONAL_DATA"
  | "CONTACT_MISSING"
  | "PROVIDER_WITHOUT_HOURS";

/** phase-12 §2.2. `null` for a finding about records rather than about prose. */
export type KnowledgeRule = "K1" | "K2" | "K3" | "K4" | "K5" | "K6" | "K7" | "K8";

export type TextKind = "PROFILE" | "SERVICE" | "FAQ";

/** One piece of tenant-authored prose, as the assistant would read it. */
export interface KnowledgeText {
  kind: TextKind;
  /** The service's or FAQ's id; null for a profile. */
  id: string | null;
  /** The service's name, or the FAQ's question; null for a profile. */
  name: string | null;
  locale: string;
  text: string;
}

export interface KnowledgeSnapshot {
  defaultLocale: string;
  /** The locales the assistant answers in. */
  supportedLocales: string[];
  /** Bookable services only — the same set the assistant is told is complete. */
  services: {
    id: string;
    name: string;
    /** Its own name plus every translated name. */
    names: string[];
    priceMinor: number | null;
    currency: string | null;
    /** Locales with a translation row. */
    translatedLocales: string[];
  }[];
  /** Bookable providers only. */
  providers: { id: string; name: string; hasHours: boolean }[];
  /** Cities of active locations. */
  locationCities: string[];
  /** Every bookable provider's weekly periods, at active locations. ISO weekday. */
  hours: { weekday: number; startTime: string; endTime: string }[];
  contactEmail: string | null;
  contactPhone: string | null;
  texts: KnowledgeText[];
}

export interface KnowledgeFinding {
  code: FindingCode;
  severity: FindingSeverity;
  rule: KnowledgeRule | null;
  source: {
    kind: TextKind | "RECORDS";
    id: string | null;
    name: string | null;
    locale: string | null;
  };
  /** The offending text, as written; empty for a finding about something absent. */
  excerpt: string;
  /** What the records say instead — names, cities, an hours summary. */
  expected: string[];
  /** A probable intended value, e.g. the provider a misspelt name resembles. */
  suggestion: string | null;
}
