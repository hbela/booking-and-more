"use client";

import { useMutation } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import type { Language, SiteImportDraft } from "@bam/contracts";
import { ApiError, apiFetch, formatMoney, toMinorUnits } from "@/lib/api-client";
import { CreateServiceForm } from "./create-service-form";
import { aiErrorKey } from "./knowledge-health";
import { Button } from "./ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card";
import { ErrorText } from "./ui/form-field";

const LANGUAGE_LABELS = { hu: "hungarian", en: "english", de: "german", fr: "french" } as const;

type Proposal = SiteImportDraft["services"][number];

/**
 * docs/phase-12-site-import.md §4: drafts of the default-language profile,
 * services and FAQs, read from the organization's own website.
 *
 * Nothing here saves on its own. The profile goes into the profile editor and
 * is saved with it; a FAQ is added through the ordinary FAQ route; a service
 * opens the ordinary create form, pre-filled, and the owner has to supply a
 * duration the site did not state. Each piece meets the knowledge budget and
 * the consistency check exactly as typed text does.
 */
export function SiteImportCard({
  tenantId,
  domain,
  language,
  canManageServices,
  onUseProfile,
  onAddFaq,
  addingFaq,
}: {
  tenantId: string;
  domain: string;
  /** The organization's default language, which everything is drafted in. */
  language: Language;
  canManageServices: boolean;
  onUseProfile: (text: string) => void;
  onAddFaq: (faq: { question: string; answer: string }, onDone: () => void) => void;
  addingFaq: boolean;
}): React.ReactElement {
  const t = useTranslations("businessKnowledge");
  const healthText = useTranslations("knowledgeHealth");
  const locale = useLocale();
  const [draft, setDraft] = useState<SiteImportDraft | null>(null);
  const [profileUsed, setProfileUsed] = useState(false);
  // Keyed by position in the draft, which never changes once it has arrived.
  const [gone, setGone] = useState<ReadonlySet<string>>(new Set());
  const [added, setAdded] = useState<ReadonlySet<string>>(new Set());
  const [open, setOpen] = useState<number | null>(null);

  const languageName = t(LANGUAGE_LABELS[language]);
  const inSentence = locale === "hu" ? languageName.toLocaleLowerCase("hu") : languageName;
  const drop = (key: string) => setGone((current) => new Set(current).add(key));

  const read = useMutation({
    mutationFn: () =>
      apiFetch<SiteImportDraft>("/v1/assistant/knowledge/site-import", {
        method: "POST",
        tenantId,
        body: {},
      }),
    onSuccess: (result) => {
      setDraft(result);
      setProfileUsed(false);
      setGone(new Set());
      setAdded(new Set());
      setOpen(null);
    },
  });

  const errorText = (error: unknown): string => {
    if (error instanceof ApiError && error.code === "SITE_UNREACHABLE") {
      const reason =
        typeof error.details === "object" && error.details !== null && "reason" in error.details
          ? error.details.reason
          : null;
      if (reason === "no_text") return t("import.noText", { domain });
      if (reason === "blocked_address" || reason === "off_site")
        return t("import.blocked", { domain });
      return t("import.unreachable", { domain });
    }
    return healthText(aiErrorKey(error));
  };

  const services = draft?.services.flatMap((service, index) =>
    gone.has(`s${String(index)}`) ? [] : [{ service, index }],
  );
  const faqs = draft?.faqs.flatMap((faq, index) =>
    gone.has(`f${String(index)}`) ? [] : [{ faq, index }],
  );

  return (
    <Card className="lg:col-span-2">
      <CardHeader>
        <CardTitle>{t("import.title", { domain })}</CardTitle>
        <CardDescription>{t("import.hint", { language: inSentence })}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <Button type="button" disabled={read.isPending} onClick={() => read.mutate()}>
            {read.isPending
              ? t("import.running")
              : draft
                ? t("import.again")
                : t("import.run", { domain })}
          </Button>
          {read.isPending ? (
            <p className="text-sm text-ink-muted" aria-live="polite">
              {t("import.wait")}
            </p>
          ) : null}
        </div>
        {read.isError ? <ErrorText>{errorText(read.error)}</ErrorText> : null}

        {draft ? (
          <div className="grid gap-6" aria-live="polite">
            <p className="text-sm text-ink-muted">
              {t("import.summary", { pages: draft.pages.length })}{" "}
              {draft.discarded > 0 ? t("import.discarded", { count: draft.discarded }) : null}{" "}
              <span className="text-warning">{t("import.nothingSaved")}</span>
            </p>

            <section className="grid gap-2">
              <h3 className="font-semibold">{t("import.profileTitle")}</h3>
              {draft.profile ? (
                <>
                  <div
                    lang={draft.language}
                    className="max-h-64 overflow-y-auto rounded-lg border border-dashed border-line p-3 text-sm whitespace-pre-wrap"
                  >
                    {draft.profile}
                  </div>
                  <div className="flex flex-wrap items-center gap-3">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        onUseProfile(draft.profile!);
                        setProfileUsed(true);
                      }}
                    >
                      {t("import.useProfile", { language: inSentence })}
                    </Button>
                    {profileUsed ? (
                      <p className="text-sm text-ink-muted">{t("import.profileUsed")}</p>
                    ) : null}
                  </div>
                </>
              ) : (
                <p className="text-sm text-ink-muted">{t("import.none")}</p>
              )}
            </section>

            <section className="grid gap-2">
              <h3 className="font-semibold">{t("import.servicesTitle")}</h3>
              <p className="text-sm text-ink-muted">{t("import.servicesHint")}</p>
              {services?.length ? (
                <ul className="grid gap-2">
                  {services.map(({ service, index }) => (
                    <ServiceProposal
                      key={index}
                      tenantId={tenantId}
                      service={service}
                      index={index}
                      language={draft.language}
                      canAdd={canManageServices}
                      isOpen={open === index}
                      isAdded={added.has(`s${String(index)}`)}
                      onOpen={() => setOpen(open === index ? null : index)}
                      onDiscard={() => drop(`s${String(index)}`)}
                      onCreated={() => {
                        setAdded((current) => new Set(current).add(`s${String(index)}`));
                        setOpen(null);
                      }}
                    />
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-ink-muted">{t("import.none")}</p>
              )}
            </section>

            <section className="grid gap-2">
              <h3 className="font-semibold">{t("import.faqsTitle")}</h3>
              {faqs?.length ? (
                <ul className="grid gap-2">
                  {faqs.map(({ faq, index }) => (
                    <li
                      key={index}
                      className="flex items-start justify-between gap-3 rounded-lg border border-dashed border-line p-3"
                    >
                      <div lang={draft.language}>
                        <p className="font-semibold">{faq.question}</p>
                        <p className="text-sm text-ink-muted">{faq.answer}</p>
                        <SourceLink url={faq.sourceUrl} />
                      </div>
                      <div className="flex gap-1">
                        <Button
                          type="button"
                          size="sm"
                          disabled={addingFaq}
                          onClick={() =>
                            onAddFaq({ question: faq.question, answer: faq.answer }, () =>
                              drop(`f${String(index)}`),
                            )
                          }
                        >
                          {t("draft.add")}
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => drop(`f${String(index)}`)}
                        >
                          {t("draft.discard")}
                        </Button>
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-ink-muted">{t("import.none")}</p>
              )}
            </section>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function SourceLink({ url }: { url: string }): React.ReactElement {
  const t = useTranslations("businessKnowledge");
  const path = (() => {
    try {
      const parsed = new URL(url);
      return `${parsed.hostname}${parsed.pathname}`;
    } catch {
      return url;
    }
  })();
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="text-xs text-ink-muted underline"
    >
      {t("import.source", { page: path })}
    </a>
  );
}

function ServiceProposal({
  tenantId,
  service,
  index,
  language,
  canAdd,
  isOpen,
  isAdded,
  onOpen,
  onDiscard,
  onCreated,
}: {
  tenantId: string;
  service: Proposal;
  index: number;
  language: string;
  canAdd: boolean;
  isOpen: boolean;
  isAdded: boolean;
  onOpen: () => void;
  onDiscard: () => void;
  onCreated: () => void;
}): React.ReactElement {
  const t = useTranslations("businessKnowledge");
  const locale = useLocale();
  const price =
    service.price !== null && service.currency !== null
      ? formatMoney(toMinorUnits(service.price, service.currency), service.currency, locale)
      : null;

  return (
    <li className="grid gap-3 rounded-lg border border-dashed border-line p-3">
      <div className="flex items-start justify-between gap-3">
        <div lang={language}>
          <p className="font-semibold">{service.name}</p>
          <p className="text-sm text-ink-muted">
            {[
              price ?? t("import.noPrice"),
              service.durationMinutes === null
                ? t("import.noDuration")
                : t("import.duration", { minutes: service.durationMinutes }),
            ].join(" · ")}
          </p>
          {service.description ? <p className="text-sm">{service.description}</p> : null}
          <SourceLink url={service.sourceUrl} />
        </div>
        <div className="flex shrink-0 gap-1">
          {isAdded ? (
            <p className="text-sm text-success">{t("import.added")}</p>
          ) : service.existingServiceId ? (
            <p className="text-sm text-ink-muted">{t("import.existing")}</p>
          ) : canAdd ? (
            <Button
              type="button"
              size="sm"
              variant={isOpen ? "outline" : "default"}
              aria-expanded={isOpen}
              aria-controls={`import-service-${String(index)}`}
              onClick={onOpen}
            >
              {isOpen ? t("import.close") : t("draft.add")}
            </Button>
          ) : null}
          {isAdded ? null : (
            <Button type="button" variant="ghost" size="sm" onClick={onDiscard}>
              {t("draft.discard")}
            </Button>
          )}
        </div>
      </div>
      {isOpen && !isAdded ? (
        <div id={`import-service-${String(index)}`} className="grid gap-2">
          {service.durationMinutes === null ? (
            <p className="text-sm text-warning">{t("import.setDuration")}</p>
          ) : null}
          <CreateServiceForm
            tenantId={tenantId}
            idPrefix={`import-service-${String(index)}`}
            initial={{
              name: service.name,
              description: service.description ?? "",
              price: service.price === null ? "" : String(service.price),
              ...(service.currency ? { currency: service.currency } : {}),
              // Blank and required when the site did not say: a guessed
              // duration would become a real diary rule.
              durationMinutes:
                service.durationMinutes === null ? "" : String(service.durationMinutes),
            }}
            onCreated={onCreated}
          />
        </div>
      ) : null}
    </li>
  );
}
