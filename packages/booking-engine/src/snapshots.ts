/**
 * What a booking records about the world at the moment it was made.
 * tech-impl §10.13.
 *
 * ## Why a booking copies instead of joining
 *
 * CLAUDE.md rule 11 keeps catalogue rows alive forever — archived, never
 * deleted — so a booking's foreign keys never dangle. That solves referential
 * integrity and nothing else: a service can be renamed from "Cleaning" to
 * "Hygiene visit" and repriced from 12000 to 15000, and a booking that joins
 * through to it will cheerfully report that the customer agreed to a price they
 * never saw and a treatment under a name that did not exist.
 *
 * So the booking copies the handful of facts a confirmation email, an invoice
 * and a dispute all depend on. The foreign keys stay for reporting ("how many
 * cleanings this quarter"); the snapshots are what the customer was told.
 */

export interface BookingSnapshot {
  customerName: string;
  customerEmail: string | null;
  customerPhone: string | null;
  serviceName: string;
  priceMinor: number | null;
  currency: string | null;
}

export function buildBookingSnapshot(input: {
  customer: { fullName: string; email: string | null; phone: string | null };
  /** Already localised by the caller — the tenant's language decides, not ours. */
  serviceName: string;
  priceMinor: number | null;
  currency: string | null;
}): BookingSnapshot {
  // A price without a currency is a number nobody can act on, and a currency
  // without a price says nothing. Either both travel or neither does — this is
  // the one place that can enforce it, since the columns are independently
  // nullable (a NULL price means "on consultation", which is not free).
  const priced = input.priceMinor !== null && input.currency !== null;

  return {
    customerName: input.customer.fullName.trim(),
    customerEmail: input.customer.email,
    customerPhone: input.customer.phone,
    serviceName: input.serviceName.trim(),
    priceMinor: priced ? input.priceMinor : null,
    currency: priced ? input.currency : null,
  };
}

// ---------------------------------------------------------------------------
// Customer matching
//
// tech-impl §10.11: normalized email and phone fields exist for matching, and
// records are never merged on name alone. Two people called Nagy Péter is a
// Tuesday in Hungary; merging their booking histories is a data-protection
// incident, not a convenience.
// ---------------------------------------------------------------------------

/**
 * Fold an address to its matching form.
 *
 * Case only, plus surrounding whitespace. Deliberately *not* clever: stripping
 * dots from Gmail local parts or cutting `+tag` suffixes is correct for one
 * provider and wrong in general, and being wrong here silently attaches one
 * person's appointments to another's record.
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Fold a phone number to its matching form: a leading `+` if present, then
 * digits.
 *
 * This is a matching key, not validation and not E.164. It will not guess a
 * country code — `06 30 123 4567` and `+36 30 123 4567` are the same Hungarian
 * number to a human and stay different keys here, because inferring the country
 * from the server's locale is how a predecessor merged a Hungarian customer
 * with an Austrian one. The right fix is asking for the country, which belongs
 * in the form rather than in a normalizer.
 */
export function normalizePhone(phone: string): string {
  const trimmed = phone.trim();
  const digits = trimmed.replace(/\D/g, "");
  return trimmed.startsWith("+") ? `+${digits}` : digits;
}

/**
 * Does an incoming customer match an existing record?
 *
 * Contact details only. A name is corroboration, never evidence — see the
 * section note above.
 */
export function customerMatches(
  existing: { normalizedEmail: string | null; normalizedPhone: string | null },
  incoming: { email: string | null; phone: string | null },
): boolean {
  if (incoming.email !== null && existing.normalizedEmail !== null) {
    if (normalizeEmail(incoming.email) === existing.normalizedEmail) return true;
  }

  if (incoming.phone !== null && existing.normalizedPhone !== null) {
    const normalized = normalizePhone(incoming.phone);
    // An empty normalization ("---") must never match another empty one.
    if (normalized.length > 0 && normalized === existing.normalizedPhone) return true;
  }

  return false;
}
