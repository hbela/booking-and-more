"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Copy } from "lucide-react";
import { buildWebsiteLinks, type WebsiteLinks as Links } from "@/lib/website-links";
import { Button } from "./ui/button";
import { Section } from "./ui/section";

/**
 * "Put booking on your website": the links and snippets that turn a subscribed
 * organization into the shape of `demo/wellness`
 * (docs/customer-onboarding-and-website-links.md §2.2).
 *
 * Built from `window.location.origin` because the dashboard is served on the
 * app's own host, so staging hands out staging links. That is only known after
 * mount, which is why the first render is empty rather than guessed.
 */
export function WebsiteLinks({
  slug,
  domain,
  defaultLanguage,
  assistant,
}: {
  slug: string;
  domain: string | null;
  defaultLanguage: string;
  assistant: boolean;
}): React.ReactElement | null {
  const t = useTranslations("websiteLinks");
  const [links, setLinks] = useState<Links | null>(null);

  useEffect(() => {
    setLinks(
      buildWebsiteLinks({
        origin: window.location.origin,
        slug,
        domain,
        defaultLanguage,
        assistant,
      }),
    );
  }, [slug, domain, defaultLanguage, assistant]);

  if (!links) return null;

  const rows: { id: string; label: string; value: string }[] = [
    { id: "booking-hu", label: t("bookingHu"), value: links.booking.hu },
    { id: "booking-en", label: t("bookingEn"), value: links.booking.en },
    ...(links.chat
      ? [
          { id: "chat-hu", label: t("chatHu"), value: links.chat.hu },
          { id: "chat-en", label: t("chatEn"), value: links.chat.en },
        ]
      : []),
    { id: "staff-sign-in", label: t("staffSignIn"), value: links.staffSignIn },
    { id: "staff-install", label: t("staffInstall"), value: links.staffInstall },
  ];

  return (
    <Section title={t("title")} description={t("description")} variant="card">
      <div className="flex flex-col gap-8">
        <div className="flex flex-col gap-4">
          <h3 className="font-semibold">{t("linksTitle")}</h3>
          <ul className="flex flex-col gap-4">
            {rows.map((row) => (
              <li key={row.id}>
                <CopyField id={row.id} label={row.label} value={row.value} />
              </li>
            ))}
          </ul>
        </div>

        <div className="flex flex-col gap-4">
          <h3 className="font-semibold">{t("snippetsTitle")}</h3>
          <p className="text-sm leading-relaxed text-ink-muted">{t("snippetsDescription")}</p>
          <CopyField
            id="snippet-booking"
            label={t("bookingButton")}
            hint={t("bookingButtonHint")}
            value={links.bookingButtonHtml}
            multiline
          />
          <CopyField
            id="snippet-staff"
            label={t("staffLink")}
            hint={t("staffLinkHint")}
            value={links.staffLinkHtml}
            multiline
          />
        </div>
      </div>
    </Section>
  );
}

function CopyField({
  id,
  label,
  hint,
  value,
  multiline = false,
}: {
  id: string;
  label: string;
  hint?: string;
  value: string;
  multiline?: boolean;
}): React.ReactElement {
  const t = useTranslations("websiteLinks");
  const hintId = hint ? `${id}-hint` : undefined;

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(value);
      toast.success(t("copied"));
    } catch {
      // Clipboard access can be refused; the text is selectable either way.
      toast.error(t("copyFailed"));
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      {hint ? (
        <p id={hintId} className="text-sm text-ink-muted">
          {hint}
        </p>
      ) : null}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
        {multiline ? (
          <textarea
            id={id}
            readOnly
            value={value}
            rows={3}
            aria-describedby={hintId}
            onFocus={(event) => event.currentTarget.select()}
            className="min-w-0 flex-1 rounded-md border border-line bg-surface-sunken p-3 font-mono text-sm break-all"
          />
        ) : (
          <input
            id={id}
            readOnly
            value={value}
            aria-describedby={hintId}
            onFocus={(event) => event.currentTarget.select()}
            className="min-h-11 min-w-0 flex-1 rounded-md border border-line bg-surface-sunken px-3 font-mono text-sm"
          />
        )}
        <Button
          type="button"
          variant="outline"
          onClick={() => void copy()}
          aria-label={t("copyLabel", { label })}
        >
          <Copy size={16} aria-hidden="true" />
          {t("copy")}
        </Button>
      </div>
    </div>
  );
}
