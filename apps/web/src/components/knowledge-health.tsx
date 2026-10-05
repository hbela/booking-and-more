"use client";

import { toast } from "sonner";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import type { KnowledgeFindingView, KnowledgeHealth } from "@bam/contracts";
import { apiFetch } from "@/lib/api-client";
import { Link } from "@/i18n/navigation";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card";
import { ErrorText, FormField, TextField } from "./ui/form-field";
import { ListLoading } from "./ui/loading";
import { Textarea } from "./ui/textarea";

export const knowledgeHealthKey = (tenantId: string) => ["knowledge-health", tenantId];

export function useKnowledgeHealth(tenantId: string) {
  return useQuery({
    queryKey: knowledgeHealthKey(tenantId),
    queryFn: () => apiFetch<KnowledgeHealth>("/v1/assistant/knowledge/health", { tenantId }),
  });
}

const LANGUAGE_KEYS: Record<string, "hungarian" | "english" | "german" | "french"> = {
  hu: "hungarian",
  en: "english",
  de: "german",
  fr: "french",
};

const RULES = ["K1", "K2", "K3", "K4", "K5", "K6", "K7", "K8"] as const;

/** The screen that fixes a finding, when it is not the text on this page. */
function fixHref(finding: KnowledgeFindingView): string | null {
  switch (finding.code) {
    case "UNBOOKABLE_SERVICE_MENTIONED":
    case "PRICE_NOT_RECORDED":
      return "/dashboard/services";
    case "PERSON_NOT_A_PROVIDER":
    case "PROVIDER_WITHOUT_HOURS":
    case "HOURS_MISMATCH":
      return "/dashboard/providers";
    case "CITY_MISMATCH":
      return "/dashboard/locations";
    case "LOCALE_MISSING":
      return finding.source.kind === "SERVICE" ? "/dashboard/services" : null;
    default:
      return null;
  }
}

/**
 * Where the company profile, service descriptions and FAQs contradict the
 * records the assistant treats as authoritative (phase-12 §5.1).
 */
export function KnowledgeHealthCard({ tenantId }: { tenantId: string }) {
  const t = useTranslations("knowledgeHealth");
  const uiLocale = useLocale();
  const languages = useTranslations("businessKnowledge");
  const health = useKnowledgeHealth(tenantId);
  const language = (locale: string | null) =>
    locale && LANGUAGE_KEYS[locale] ? languages(LANGUAGE_KEYS[locale]) : (locale ?? "");

  const message = (finding: KnowledgeFindingView) => {
    const values = {
      excerpt: finding.excerpt,
      expected: finding.expected.length > 0 ? finding.expected.join(", ") : t("noneRecorded"),
      suggestion: finding.suggestion ?? "",
      // Hungarian writes language names in lower case mid-sentence ("angol").
      language:
        uiLocale === "hu"
          ? language(finding.source.locale).toLocaleLowerCase("hu")
          : language(finding.source.locale),
    };
    return finding.code === "LOCALE_MISSING"
      ? t(`codes.LOCALE_MISSING_${finding.source.kind as "PROFILE" | "SERVICE" | "FAQ"}`, values)
      : t(`codes.${finding.code}`, values);
  };

  const source = (finding: KnowledgeFindingView) => {
    const lang = language(finding.source.locale);
    switch (finding.source.kind) {
      case "PROFILE":
        return t("source.profile", { language: lang });
      case "SERVICE":
        return finding.source.name
          ? t("source.service", { name: finding.source.name, language: lang })
          : t("source.services", { language: lang });
      case "FAQ":
        return finding.source.name
          ? t("source.faq", { name: finding.source.name })
          : t("source.faqs", { language: lang });
      default:
        return t("source.records");
    }
  };

  return (
    <Card id="knowledge-health" className="lg:col-span-2">
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
        <CardDescription>{t("hint")}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {health.isError ? <ErrorText>{t("error")}</ErrorText> : null}
        {health.isPending ? <ListLoading label={t("loading")} /> : null}
        {health.data ? (
          <>
            <p aria-live="polite" className="font-semibold">
              {health.data.findings.length === 0
                ? t("clean")
                : t("summary", { errors: health.data.errors, warnings: health.data.warnings })}
            </p>
            {health.data.findings.length > 0 ? (
              <ul className="grid gap-2">
                {health.data.findings.map((finding, index) => {
                  const href = fixHref(finding);
                  return (
                    <li
                      key={`${finding.code}-${finding.source.kind}-${finding.source.id ?? ""}-${finding.source.locale ?? ""}-${index}`}
                      className="grid gap-1 rounded-lg border border-line p-3"
                    >
                      <div className="flex flex-wrap items-center gap-2 text-xs text-ink-muted">
                        <Badge variant={finding.severity === "ERROR" ? "destructive" : "warning"}>
                          {finding.severity === "ERROR" ? t("error_badge") : t("warning_badge")}
                        </Badge>
                        <span>{source(finding)}</span>
                        {finding.rule ? <span>· {t(`rules.${finding.rule}.title`)}</span> : null}
                      </div>
                      <p>{message(finding)}</p>
                      {finding.code === "PERSON_NOT_A_PROVIDER" && finding.suggestion ? (
                        <p className="text-sm text-ink-muted">
                          {t("didYouMean", { suggestion: finding.suggestion })}
                        </p>
                      ) : null}
                      {finding.excerpt &&
                      ![
                        "UNBOOKABLE_SERVICE_MENTIONED",
                        "PERSON_NOT_A_PROVIDER",
                        "PERSONAL_DATA",
                        "PROVIDER_WITHOUT_HOURS",
                      ].includes(finding.code) ? (
                        <blockquote className="border-l-2 border-line pl-3 text-sm text-ink-muted">
                          {finding.excerpt}
                        </blockquote>
                      ) : null}
                      {href ? (
                        <Link href={href} className="text-sm underline underline-offset-4">
                          {t("fix")}
                        </Link>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            ) : null}
          </>
        ) : null}
        <details className="rounded-lg border border-line p-3">
          <summary className="cursor-pointer font-semibold">{t("rulesTitle")}</summary>
          <p className="mt-2 text-sm text-ink-muted">{t("rulesIntro")}</p>
          <ol className="mt-2 grid gap-2 text-sm">
            {RULES.map((rule) => (
              <li key={rule}>
                <span className="font-semibold">{t(`rules.${rule}.title`)}.</span>{" "}
                {t(`rules.${rule}.text`)}
              </li>
            ))}
          </ol>
        </details>
      </CardContent>
    </Card>
  );
}

interface ContactDetails {
  contactEmail: string | null;
  contactPhone: string | null;
  bookingPolicy: string | null;
  cancellationPolicy: string | null;
}

/**
 * The records the assistant quotes for "how do I reach you" and "can I cancel"
 * (phase-12 §2.1). The API has always accepted them; nothing on screen set them.
 */
export function ContactDetailsCard({
  tenantId,
  canManage,
}: {
  tenantId: string;
  canManage: boolean;
}) {
  const t = useTranslations("knowledgeHealth.contact");
  const client = useQueryClient();
  const current = useQuery({
    queryKey: ["tenant-current", tenantId],
    queryFn: () => apiFetch<ContactDetails>("/v1/tenants/current", { tenantId }),
  });
  const save = useMutation({
    mutationFn: (body: ContactDetails) =>
      apiFetch("/v1/tenants/current", { method: "PATCH", tenantId, body }),
    onSuccess: () => {
      toast.success(t("saved"));
      void client.invalidateQueries({ queryKey: ["tenant-current", tenantId] });
      void client.invalidateQueries({ queryKey: knowledgeHealthKey(tenantId) });
    },
  });
  const text = (data: FormData, name: string) => {
    const value = data.get(name);
    return typeof value === "string" && value.trim() ? value.trim() : null;
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
        <CardDescription>{t("hint")}</CardDescription>
      </CardHeader>
      <CardContent>
        {current.isError || save.isError ? <ErrorText>{t("error")}</ErrorText> : null}
        {current.isPending ? <ListLoading label={t("loading")} /> : null}
        {current.data ? (
          <form
            key={JSON.stringify(current.data)}
            className="grid gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              const data = new FormData(event.currentTarget);
              save.mutate({
                contactEmail: text(data, "contactEmail"),
                contactPhone: text(data, "contactPhone"),
                bookingPolicy: text(data, "bookingPolicy"),
                cancellationPolicy: text(data, "cancellationPolicy"),
              });
            }}
          >
            <TextField
              id="contact-email"
              name="contactEmail"
              type="email"
              label={t("email")}
              defaultValue={current.data.contactEmail ?? ""}
              readOnly={!canManage}
            />
            <TextField
              id="contact-phone"
              name="contactPhone"
              type="tel"
              maxLength={40}
              label={t("phone")}
              defaultValue={current.data.contactPhone ?? ""}
              readOnly={!canManage}
            />
            <FormField id="booking-policy" label={t("bookingPolicy")}>
              <Textarea
                id="booking-policy"
                name="bookingPolicy"
                maxLength={4000}
                defaultValue={current.data.bookingPolicy ?? ""}
                readOnly={!canManage}
              />
            </FormField>
            <FormField id="cancellation-policy" label={t("cancellationPolicy")}>
              <Textarea
                id="cancellation-policy"
                name="cancellationPolicy"
                maxLength={4000}
                defaultValue={current.data.cancellationPolicy ?? ""}
                readOnly={!canManage}
              />
            </FormField>
            {canManage ? (
              <Button type="submit" disabled={save.isPending}>
                {t("save")}
              </Button>
            ) : null}
          </form>
        ) : null}
      </CardContent>
    </Card>
  );
}
