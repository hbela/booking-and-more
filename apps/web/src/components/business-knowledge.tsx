"use client";

import { toast } from "sonner";
import { ListLoading } from "./ui/loading";
import { useState } from "react";
import { knowledgeCharacters, type Language } from "@bam/contracts";
import { KnowledgeBudget, isKnowledgeLimitError } from "./knowledge-budget";
import { useLocale, useTranslations } from "next-intl";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api-client";
import { Button } from "./ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card";
import { ErrorText } from "./ui/form-field";
import { Input } from "./ui/input";
import { NativeSelect } from "./ui/native-select";
import { Textarea } from "./ui/textarea";

const LANGUAGES = ["hu", "en", "de", "fr"] as const;
const LANGUAGE_LABELS = { hu: "hungarian", en: "english", de: "german", fr: "french" } as const;
const PROFILE_FIELDS = {
  hu: "businessDescriptionHu",
  en: "businessDescriptionEn",
  de: "businessDescriptionDe",
  fr: "businessDescriptionFr",
} as const;

interface Faq {
  id: string;
  locale: (typeof LANGUAGES)[number];
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
  const budgetText = useTranslations("knowledgeBudget");
  const [profileChanges, setProfileChanges] = useState<Partial<Record<Language, number>>>({});
  const [faqChanges, setFaqChanges] = useState<Partial<Record<Language, number>>>({});
  const client = useQueryClient();
  const settings = useQuery({
    queryKey: ["assistant-settings", tenantId],
    queryFn: () => apiFetch<CompanyProfile>("/v1/assistant/settings", { tenantId }),
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
    onSuccess: () => {
      toast.success(t("saved"));
      setProfileChanges({});
      void client.invalidateQueries({ queryKey: ["knowledge-usage", tenantId] });
      void client.invalidateQueries({ queryKey: ["assistant-settings", tenantId] });
    },
  });
  const addFaq = useMutation({
    mutationFn: (body: Omit<Faq, "id">) =>
      apiFetch("/v1/assistant/faqs", {
        method: "POST",
        tenantId,
        body: { ...body, active: true, sortOrder: 0 },
      }),
    onSuccess: () => {
      setFaqChanges({});
      void client.invalidateQueries({ queryKey: ["knowledge-usage", tenantId] });
      void client.invalidateQueries({ queryKey: ["assistant-faqs", tenantId] });
    },
  });
  const removeFaq = useMutation({
    mutationFn: (id: string) =>
      apiFetch(`/v1/assistant/faqs/${id}`, { method: "DELETE", tenantId }),
    onSuccess: () => {
      setFaqChanges({});
      void client.invalidateQueries({ queryKey: ["knowledge-usage", tenantId] });
      void client.invalidateQueries({ queryKey: ["assistant-faqs", tenantId] });
    },
  });
  return (
    <div className="grid items-start gap-6 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>{t("title")}</CardTitle>
          <CardDescription>{t("hint")}</CardDescription>
        </CardHeader>
        <CardContent>
          {settings.error || save.isError ? (
            <ErrorText>
              {isKnowledgeLimitError(save.error) ? budgetText("error") : t("error")}
            </ErrorText>
          ) : null}
          {settings.data ? (
            <form
              onChange={(event) => {
                const data = new FormData(event.currentTarget);
                setProfileChanges(
                  Object.fromEntries(
                    LANGUAGES.map((language) => [
                      language,
                      knowledgeCharacters(formText(data, `description-${language}`)) -
                        knowledgeCharacters(settings.data?.[PROFILE_FIELDS[language]]),
                    ]),
                  ),
                );
              }}
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

                    readOnly={!canManage}
                  />
                </label>
              ))}
              <KnowledgeBudget tenantId={tenantId} changes={profileChanges} />
              <p className="text-sm text-ink-muted">{t("translationHint")}</p>
              {canManage ? (
                <Button type="submit" disabled={save.isPending}>
                  {t("save")}
                </Button>
              ) : null}
            </form>
          ) : settings.isPending ? (
            <ListLoading label={t("loading")} />
          ) : null}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>{t("faqs")}</CardTitle>
          <CardDescription>{t("faqHint")}</CardDescription>
        </CardHeader>
        <CardContent>
          {faqs.error || addFaq.isError || removeFaq.isError ? (
            <ErrorText>
              {isKnowledgeLimitError(addFaq.error) ? budgetText("error") : t("error")}
            </ErrorText>
          ) : null}
          {canManage ? (
            <form
              onChange={(event) => {
                const data = new FormData(event.currentTarget);
                const language = LANGUAGES.find((entry) => entry === data.get("locale")) ?? "hu";
                setFaqChanges({
                  [language]:
                    knowledgeCharacters(formText(data, "question")) +
                    knowledgeCharacters(formText(data, "answer")),
                });
              }}
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
                <NativeSelect name="locale" defaultValue={locale}>
                  {LANGUAGES.map((language) => (
                    <option key={language} value={language}>
                      {t(LANGUAGE_LABELS[language])}
                    </option>
                  ))}
                </NativeSelect>
              </label>
              <label>
                {t("question")}
                <Input name="question" required />
              </label>
              <label>
                {t("answer")}
                <Textarea name="answer" required />
              </label>
              <KnowledgeBudget tenantId={tenantId} changes={faqChanges} />
              <Button type="submit" disabled={addFaq.isPending}>
                {t("addFaq")}
              </Button>
            </form>
          ) : null}
          {faqs.isPending ? (
            <ListLoading label={t("loading")} />
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
                  <span className="text-xs text-ink-muted">{t(LANGUAGE_LABELS[faq.locale])}</span>
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
        </CardContent>
      </Card>
    </div>
  );
}
