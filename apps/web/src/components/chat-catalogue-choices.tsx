import React from "react";
import type { ConversationProvider, ConversationService } from "../lib/conversation-client";
import { formatMoney } from "../lib/api-client";
import { cn } from "../lib/utils";
import { buttonVariants } from "./ui/button";

/** The form's own wording for hu and en (`booking.anyProvider`). */
const anyProvider = {
  hu: "Bárki, aki ráér",
  en: "Anyone available",
  de: "Egal, wer frei ist",
  fr: "Toute personne disponible",
} as const;

export function ChatCatalogueChoices({
  services,
  providers,
  locale,
  disabled,
  onPick,
  onPickProvider,
}: {
  services?: ConversationService[] | undefined;
  providers?: ConversationProvider[] | undefined;
  locale: "hu" | "en" | "de" | "fr";
  disabled: boolean;
  onPick: (name: string) => void;
  /**
   * A provider tapped, `null` for "anyone available" — sent as data, never as a
   * sentence for the model (docs/phase-12-chat-slot-calendar.md §5).
   */
  onPickProvider: (providerId: string | null, label: string) => void;
}): React.ReactElement {
  // The outline button as a full-width, left-aligned choice card.
  const buttonClass = cn(
    buttonVariants({ variant: "outline" }),
    "w-full justify-start py-3 text-left",
  );
  return (
    <>
      {services?.length ? (
        <ul
          className="grid gap-2 sm:grid-cols-2"
          aria-label={
            { hu: "Szolgáltatások", en: "Services", de: "Leistungen", fr: "Prestations" }[locale]
          }
        >
          {services.map((service) => (
            <li key={service.id}>
              <button
                type="button"
                className={buttonClass}
                disabled={disabled}
                onClick={() => onPick(service.name)}
              >
                <span className="block font-medium">{service.name}</span>
                <span className="block text-xs text-ink-muted">
                  {service.durationMinutes}{" "}
                  {{ hu: "perc", en: "minutes", de: "Minuten", fr: "minutes" }[locale]}
                  {service.priceMinor !== null && service.currency
                    ? ` · ${formatMoney(service.priceMinor, service.currency, locale)}`
                    : ""}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {providers?.length ? (
        <ul
          className="grid gap-2 sm:grid-cols-2"
          aria-label={
            { hu: "Szakemberek", en: "Providers", de: "Fachkräfte", fr: "Professionnels" }[locale]
          }
        >
          {/* "Anyone" first, as on the form: it is what most customers want,
              and offering it last makes people feel they have to choose a name. */}
          <li>
            <button
              type="button"
              className={buttonClass}
              disabled={disabled}
              onClick={() => onPickProvider(null, anyProvider[locale])}
            >
              {anyProvider[locale]}
            </button>
          </li>
          {providers.map((provider) => (
            <li key={provider.id}>
              <button
                type="button"
                className={buttonClass}
                disabled={disabled}
                onClick={() => onPickProvider(provider.id, provider.displayName)}
              >
                {provider.displayName}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </>
  );
}
