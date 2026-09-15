"use client";

import { useLocale, useTranslations } from "next-intl";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api-client";
import { Button } from "./ui/button";
import { Card } from "./ui/card";
import { ErrorText } from "./ui/field";
import { Input, Select, Textarea } from "./ui/input";

const LANGUAGES = ["hu", "en", "de", "fr"] as const;
const LANGUAGE_LABELS = { hu: "hungarian", en: "english", de: "german", fr: "french" } as const;
const PROFILE_FIELDS = {
  hu: "businessDescriptionHu", en: "businessDescriptionEn",
  de: "businessDescriptionDe", fr: "businessDescriptionFr",
} as const;

interface Faq {
  id: string;
  locale: typeof LANGUAGES[number];
  question: string;
  answer: string;
}

interface CompanyProfile {
  businessDescriptionHu: string | null;
  businessDescriptionEn: string | null;
  businessDescriptionDe: string | null;
  businessDescriptionFr: string | null;
}

function formText(data: FormData, name: string): string {
  const value = data.get(name);
  return typeof value === "string" ? value.trim() : "";
}

/** Company knowledge belongs to Overview; assistant behavior stays on its own page. */
export function BusinessKnowledge({
  tenantId,
  canManage,
}: {
  tenantId: string;
  canManage: boolean;
}) {
  const t = useTranslations("businessKnowledge");
  const locale = useLocale();
  const client = useQueryClient();
  const settings = useQuery({
    queryKey: ["assistant-settings", tenantId],
    queryFn: () =>
      apiFetch<CompanyProfile>("/v1/assistant/settings", { tenantId }),
  });
  const faqs = useQuery({
    queryKey: ["assistant-faqs", tenantId],
    queryFn: () => apiFetch<{ items: Faq[] }>("/v1/assistant/faqs", { tenantId }),
  });
  const save = useMutation({
    mutationFn: (profile: CompanyProfile) =>
      apiFetch("/v1/assistant/settings", {
        method: "PATCH",
        tenantId,
        body: profile,
      }),
    onSuccess: () => void client.invalidateQueries({ queryKey: ["assistant-settings", tenantId] }),
  });
  const addFaq = useMutation({
    mutationFn: (body: Omit<Faq, "id">) =>
      apiFetch("/v1/assistant/faqs", {
        method: "POST",
        tenantId,
        body: { ...body, active: true, sortOrder: 0 },
      }),
    onSuccess: () => void client.invalidateQueries({ queryKey: ["assistant-faqs", tenantId] }),
  });
  const removeFaq = useMutation({
    mutationFn: (id: string) =>
      apiFetch(`/v1/assistant/faqs/${id}`, { method: "DELETE", tenantId }),
    onSuccess: () => void client.invalidateQueries({ queryKey: ["assistant-faqs", tenantId] }),
  });
  return (
    <div className="grid gap-6">
      <Card title={t("title")} description={t("hint")}>
        {settings.error || save.isError ? <ErrorText>{t("error")}</ErrorText> : null}
        {settings.data ? (
          <form
            key={tenantId}
            className="grid gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              const data = new FormData(event.currentTarget);
              save.mutate({
                businessDescriptionHu: formText(data, "description-hu") || null,
                businessDescriptionEn: formText(data, "description-en") || null,
                businessDescriptionDe: formText(data, "description-de") || null,
                businessDescriptionFr: formText(data, "description-fr") || null,
              });
            }}
          >
            {LANGUAGES.map((language) => (
              <label key={language}>
                {language.toUpperCase()} — {t("description")}
                <Textarea
                  name={`description-${language}`}
                  lang={language}
                  defaultValue={settings.data[PROFILE_FIELDS[language]] ?? ""}
                  maxLength={4000}
                  readOnly={!canManage}
                />
              </label>
            ))}
            <p className="text-sm text-ink-muted">{t("translationHint")}</p>
            {canManage ? (
              <Button type="submit" disabled={save.isPending}>
                {t("save")}
              </Button>
            ) : null}
            {save.isSuccess ? <p role="status">{t("saved")}</p> : null}
          </form>
        ) : settings.isPending ? (
          <p>{t("loading")}</p>
        ) : null}
      </Card>
      <Card title={t("faqs")} description={t("faqHint")}>
        {faqs.error || addFaq.isError || removeFaq.isError ? (
          <ErrorText>{t("error")}</ErrorText>
        ) : null}
        {canManage ? (
          <form
            className="grid gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              const form = event.currentTarget;
              const data = new FormData(form);
              addFaq.mutate(
                {
                  locale: LANGUAGES.find((language) => language === data.get("locale")) ?? "hu",
                  question: formText(data, "question"),
                  answer: formText(data, "answer"),
                },
                { onSuccess: () => form.reset() },
              );
            }}
          >
            <label>
              {t("language")}
              <Select name="locale" defaultValue={locale}>
                {LANGUAGES.map((language) => (
                  <option key={language} value={language}>{t(LANGUAGE_LABELS[language])}</option>
                ))}
              </Select>
            </label>
            <label>
              {t("question")}
              <Input name="question" required maxLength={500} />
            </label>
            <label>
              {t("answer")}
              <Textarea name="answer" required maxLength={4000} />
            </label>
            <Button type="submit" disabled={addFaq.isPending}>
              {t("addFaq")}
            </Button>
          </form>
        ) : null}
        {faqs.isPending ? (
          <p>{t("loading")}</p>
        ) : faqs.data?.items.length === 0 ? (
          <p>{t("empty")}</p>
        ) : null}
        <ul className="grid gap-2">
          {faqs.data?.items.map((faq) => (
            <li
              key={faq.id}
              className="flex items-start justify-between gap-3 rounded-lg border border-line p-3"
            >
              <div>
                <span className="text-xs text-ink-muted">
                  {t(LANGUAGE_LABELS[faq.locale])}
                </span>
                <p className="font-semibold">{faq.question}</p>
                <p className="text-sm text-ink-muted">{faq.answer}</p>
              </div>
              {canManage ? (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={removeFaq.isPending}
                  onClick={() => removeFaq.mutate(faq.id)}
                >
                  {t("delete")}
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
