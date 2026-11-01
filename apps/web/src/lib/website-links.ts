import { tenantAppPaths, tenantQrTarget, type AppLocale } from "@/lib/tenant-pwa";

function escapeHtml(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&#39;");
}

/**
 * What an owner puts on their own website once subscribed
 * (docs/customer-onboarding-and-website-links.md §2.2): the shape of
 * `demo/wellness`, a booking button in the page body and a staff link in the
 * header.
 */
export interface WebsiteLinks {
  booking: Record<AppLocale, string>;
  chat: Record<AppLocale, string> | null;
  staffSignIn: string;
  staffInstall: string;
  bookingButtonHtml: string;
  staffLinkHtml: string;
}

/**
 * The snippet labels are in the organization's language rather than the
 * reader's: they are copy for the clinic's own page, and an owner reading the
 * dashboard in English may still run a Hungarian website.
 */
const SNIPPET_LABELS: Record<AppLocale, { book: string; staff: string }> = {
  hu: { book: "Foglaljon időpontot", staff: "Munkatársaknak" },
  en: { book: "Book an appointment", staff: "For staff" },
};

/**
 * Inline styles only: the snippet lands in somebody else's page, whose
 * stylesheet we do not know. The colour is the brand primary, which already
 * meets 4.5:1 against white text.
 */
const BUTTON_STYLE =
  "display:inline-block;padding:12px 24px;border-radius:8px;background:#1f5cd4;color:#ffffff;font-weight:600;text-decoration:none";

export function buildWebsiteLinks({
  origin,
  slug,
  domain,
  defaultLanguage,
  assistant,
}: {
  /** The app's own origin; the dashboard is served on it. */
  origin: string;
  slug: string;
  domain: string | null;
  defaultLanguage: string;
  assistant: boolean;
}): WebsiteLinks {
  const base = origin.replace(/\/+$/u, "");
  const locale: AppLocale = defaultLanguage === "en" ? "en" : "hu";
  const prefix = locale === "en" ? "/en" : "";

  const booking = {
    hu: `${base}${tenantQrTarget(slug, "book", "hu")}`,
    en: `${base}${tenantQrTarget(slug, "book", "en")}`,
  };
  const chat = assistant
    ? {
        hu: `${base}${tenantQrTarget(slug, "chat", "hu")}`,
        en: `${base}${tenantQrTarget(slug, "chat", "en")}`,
      }
    : null;
  // The domain form is what the demo uses and what a clinic recognises as its
  // own; both resolve to the same sign-in (demo/README.md).
  const staffSignIn = `${base}${prefix}/${domain ?? slug}/sign-in`;
  const staffInstall = `${base}${tenantAppPaths(slug, "staff", locale).install}`;

  const labels = SNIPPET_LABELS[locale];
  return {
    booking,
    chat,
    staffSignIn,
    staffInstall,
    bookingButtonHtml: `<a href="${escapeHtml(booking[locale])}" style="${BUTTON_STYLE}">${escapeHtml(labels.book)}</a>`,
    staffLinkHtml: `<a href="${escapeHtml(staffSignIn)}">${escapeHtml(labels.staff)}</a>`,
  };
}
