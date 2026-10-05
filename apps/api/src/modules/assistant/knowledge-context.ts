/**
 * The two blocks the AI receptionist reads (phase-12 §4.1).
 *
 * `bookableFacts` is rendered from database records only and is authoritative
 * for every kind of fact in phase-12 §2.1's table. `businessDescription` is the
 * tenant's own prose — profile, service descriptions, FAQs — and may explain
 * those facts but never add or override one. Keeping them apart is the whole
 * point: when they were one block, a profile listing five treatments and a
 * catalogue holding one were two equally credible answers.
 *
 * Pure, so the rendering is unit-testable without a database.
 */

export interface BookableFactsInput {
  services: {
    name: string;
    durationMinutes: number;
    priceMinor: number | null;
    currency: string | null;
    requiresApproval: boolean;
    translations: { locale: string; name: string }[];
    providers: {
      customDurationMinutes: number | null;
      customPriceMinor: number | null;
      provider: { displayName: string };
    }[];
  }[];
  providers: {
    displayName: string;
    description: string | null;
    languages: string[];
    workingHours: {
      weekday: number;
      startTime: string;
      endTime: string;
      location: { name: string; active: boolean; archivedAt: Date | null } | null;
    }[];
  }[];
  locations: {
    name: string;
    type: string;
    addressLine1: string | null;
    addressLine2: string | null;
    postalCode: string | null;
    city: string | null;
    countryCode: string | null;
  }[];
  contactEmail: string | null;
  contactPhone: string | null;
  bookingPolicy: string | null;
  cancellationPolicy: string | null;
}

const NOT_RECORDED = "not recorded";
const WEEKDAYS = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

export function renderBookableFacts(input: BookableFactsInput, locale: string): string {
  const services = input.services.map((service) => {
    const name =
      service.translations.find((entry) => entry.locale === locale)?.name ?? service.name;
    const providers = service.providers.map((link) => {
      const own = [
        link.customDurationMinutes === null ? "" : `${link.customDurationMinutes} min`,
        link.customPriceMinor === null
          ? ""
          : (formatPrice(link.customPriceMinor, service.currency) ?? ""),
      ].filter(Boolean);
      return own.length === 0
        ? link.provider.displayName
        : `${link.provider.displayName} (${own.join(", ")})`;
    });
    return [
      `- ${name}`,
      `${service.durationMinutes} min`,
      `price: ${formatPrice(service.priceMinor, service.currency) ?? NOT_RECORDED}`,
      `performed by: ${providers.join(", ")}`,
      ...(service.requiresApproval ? ["the practice confirms each request"] : []),
    ].join(" | ");
  });

  const providers = input.providers.map((provider) =>
    [
      `- ${provider.displayName}`,
      ...(provider.languages.length > 0 ? [`speaks: ${provider.languages.join(", ")}`] : []),
      ...(provider.description ? [`about: ${oneLine(provider.description)}`] : []),
    ].join(" | "),
  );

  const locations = input.locations.map((location) => {
    if (location.type !== "PHYSICAL") return `- ${location.name}: ${location.type.toLowerCase()}`;
    const address = [
      location.addressLine1,
      location.addressLine2,
      [location.postalCode, location.city].filter(Boolean).join(" "),
      location.countryCode,
    ]
      .filter(Boolean)
      .join(", ");
    return `- ${location.name}: ${address || `address ${NOT_RECORDED}`}`;
  });

  const hours = input.providers.map(
    (provider) => `- ${provider.displayName}: ${weeklyHours(provider.workingHours) ?? "none"}`,
  );

  return [
    "Bookable services (the complete list; nothing else can be booked):",
    ...(services.length > 0 ? services : ["- none"]),
    "",
    "Bookable providers (the complete list of people a customer can book):",
    ...(providers.length > 0 ? providers : ["- none"]),
    "",
    "Locations:",
    ...(locations.length > 0 ? locations : ["- none"]),
    "",
    "Weekly hours when appointments can be booked, per provider.",
    "No separate opening hours are recorded; these are the practice's hours:",
    ...(hours.length > 0 ? hours : ["- none"]),
    "",
    `Contact email: ${input.contactEmail ?? NOT_RECORDED}`,
    `Contact phone: ${input.contactPhone ?? NOT_RECORDED}`,
    `Booking policy: ${input.bookingPolicy ? oneLine(input.bookingPolicy) : NOT_RECORDED}`,
    `Cancellation policy: ${input.cancellationPolicy ? oneLine(input.cancellationPolicy) : NOT_RECORDED}`,
  ].join("\n");
}

export interface BusinessDescriptionInput {
  profile: { text: string; locale: string } | null;
  services: { name: string; description: string; locale: string }[];
  faqs: { question: string; answer: string; locale: string }[];
}

const LANGUAGE_NAMES: Record<string, string> = {
  hu: "Hungarian",
  en: "English",
  de: "German",
  fr: "French",
};

/** Every piece is labelled with its language (phase-12 §4.3). */
export function renderBusinessDescription(input: BusinessDescriptionInput): string {
  const language = (locale: string) => LANGUAGE_NAMES[locale] ?? locale;
  return [
    input.profile ? `Company profile (written in ${language(input.profile.locale)}):` : "",
    input.profile?.text ?? "",
    ...input.services.map(
      (service) =>
        `\nService description — ${service.name} (written in ${language(service.locale)}):\n${service.description}`,
    ),
    ...(input.faqs.length > 0 ? [`\nFAQ (written in ${language(input.faqs[0]!.locale)}):`] : []),
    ...input.faqs.map((faq) => `Q: ${faq.question}\nA: ${faq.answer}`),
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * `Mon–Fri 09:00–17:00; Sat 09:00–12:00`. Consecutive weekdays with identical
 * periods collapse into a range. Hours at an inactive or archived location are
 * dropped, as the availability engine drops them.
 */
export function weeklyHours(
  rows: BookableFactsInput["providers"][number]["workingHours"],
): string | null {
  const byDay = new Map<number, string>();
  for (const row of rows) {
    if (row.location && (!row.location.active || row.location.archivedAt)) continue;
    const period = `${row.startTime}–${row.endTime}${row.location ? ` at ${row.location.name}` : ""}`;
    byDay.set(
      row.weekday,
      byDay.has(row.weekday) ? `${byDay.get(row.weekday)}, ${period}` : period,
    );
  }
  const days = [...byDay.keys()].sort((a, b) => a - b);
  const groups: { from: number; to: number; periods: string }[] = [];
  for (const day of days) {
    const last = groups.at(-1);
    if (last && last.to === day - 1 && last.periods === byDay.get(day)) last.to = day;
    else groups.push({ from: day, to: day, periods: byDay.get(day)! });
  }
  if (groups.length === 0) return null;
  return groups
    .map(
      (group) =>
        `${WEEKDAYS[group.from]}${group.to === group.from ? "" : `–${WEEKDAYS[group.to]}`} ${group.periods}`,
    )
    .join("; ");
}

/**
 * Minor units and currency travel together (rule 15's pairing). `Intl` decides
 * the decimal places — HUF has none, EUR two.
 */
function formatPrice(minor: number | null, currency: string | null): string | null {
  if (minor === null || !currency) return null;
  try {
    const digits =
      new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions()
        .maximumFractionDigits ?? 2;
    return `${(minor / 10 ** digits).toFixed(digits)} ${currency}`;
  } catch {
    return null;
  }
}

function oneLine(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}
