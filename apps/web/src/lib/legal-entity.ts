/**
 * The seller's details for the impresszum and the legal pages
 * (docs/public-site-and-legal-pages.md §2.1).
 *
 * Runtime configuration rather than code: the seller is a sole trader, whose
 * registered address is their own, and personal identifiers stay out of the
 * repository. Read on the server per request, so a change needs a restart and
 * not a rebuild. A field left unset is omitted from the page; production must
 * set them all, which is a launch gate rather than a boot failure, because a
 * missing impresszum line must not take the booking pages down with it.
 */
export interface LegalEntity {
  name?: string;
  address?: string;
  taxNumber?: string;
  euVatNumber?: string;
  registrationNumber?: string;
  email?: string;
}

/** Not personal, so a constant. Ekertv. 4. § asks for the hosting provider too. */
export const HOSTING_PROVIDER =
  "Hetzner Online GmbH, Industriestr. 25, 91710 Gunzenhausen, Germany";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

export function parseLegalEntity(env: Record<string, string | undefined>): LegalEntity {
  const read = (key: string): string | undefined => {
    const value = env[key]?.trim();
    return value ? value : undefined;
  };

  const entity: LegalEntity = {};
  const name = read("LEGAL_NAME");
  const address = read("LEGAL_ADDRESS");
  const taxNumber = read("LEGAL_TAX_NUMBER");
  const euVatNumber = read("LEGAL_EU_VAT_NUMBER");
  const registrationNumber = read("LEGAL_REGISTRATION_NUMBER");
  const email = read("LEGAL_EMAIL");

  if (name) entity.name = name;
  if (address) entity.address = address;
  if (taxNumber) entity.taxNumber = taxNumber;
  if (euVatNumber) entity.euVatNumber = euVatNumber;
  if (registrationNumber) entity.registrationNumber = registrationNumber;
  // A malformed address would become a broken mailto: link on every page.
  if (email && EMAIL.test(email)) entity.email = email;
  return entity;
}

export function getLegalEntity(): LegalEntity {
  return parseLegalEntity(process.env);
}
