import type { Locale } from "@/i18n/routing";
import { privacyEn } from "./privacy.en";
import { privacyHu } from "./privacy.hu";
import { refundEn } from "./refund.en";
import { refundHu } from "./refund.hu";
import { termsEn } from "./terms.en";
import { termsHu } from "./terms.hu";
import type { LegalDocument, LegalDocumentKind } from "./types";

export type { LegalBlock, LegalDocument, LegalDocumentKind, LegalSection } from "./types";

export const LEGAL_DOCUMENTS: Record<LegalDocumentKind, Record<Locale, LegalDocument>> = {
  terms: { hu: termsHu, en: termsEn },
  privacy: { hu: privacyHu, en: privacyEn },
  refund: { hu: refundHu, en: refundEn },
};

export function legalDocument(kind: LegalDocumentKind, locale: string): LegalDocument {
  return locale === "en" ? LEGAL_DOCUMENTS[kind].en : LEGAL_DOCUMENTS[kind].hu;
}
