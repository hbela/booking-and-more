import React from "react";
import type { ConversationProvider, ConversationService } from "../lib/conversation-client";

export function ChatCatalogueChoices({
  services,
  providers,
  locale,
  disabled,
  onPick,
}: {
  services?: ConversationService[] | undefined;
  providers?: ConversationProvider[] | undefined;
  locale: "hu" | "en" | "de" | "fr";
  disabled: boolean;
  onPick: (name: string) => void;
}): React.ReactElement {
  const buttonClass =
    "min-h-11 w-full rounded-lg border border-line-strong bg-surface-raised px-4 py-3 text-left text-sm hover:bg-surface disabled:cursor-not-allowed disabled:opacity-60";
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
                    ? ` · ${new Intl.NumberFormat(locale, {
                        style: "currency",
                        currency: service.currency,
                      }).format(service.priceMinor / 100)}`
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
          {providers.map((provider) => (
            <li key={provider.id}>
              <button
                type="button"
                className={buttonClass}
                disabled={disabled}
                onClick={() => onPick(provider.displayName)}
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
