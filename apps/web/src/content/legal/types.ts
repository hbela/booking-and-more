/**
 * A legal text as data, one module per document and locale, rendered by
 * `LegalDocumentView`. Plain strings and lists only: these are documents a
 * lawyer reviews, so they are kept where a reviewer can read them as prose,
 * not spread across JSX or message keys.
 *
 * Every claim in them is listed in docs/public-site-and-legal-pages.md §3. A
 * change to one of those facts must update the texts in both languages.
 */
export type LegalBlock = string | { list: readonly string[] };

export interface LegalSection {
  /** Stable anchor, the same in both languages, so links can point at a section. */
  id: string;
  heading: string;
  blocks: readonly LegalBlock[];
}

export interface LegalDocument {
  title: string;
  /** ISO date the text takes effect; set when the reviewed version is published. */
  effective: string;
  intro: readonly string[];
  sections: readonly LegalSection[];
}

export type LegalDocumentKind = "terms" | "privacy" | "refund";
