"use client";

import { toast } from "sonner";
import { ListLoading } from "./ui/loading";
import { useRef, useState } from "react";
import { knowledgeCharacters, type Language, type TranslationDraft } from "@bam/contracts";
import { KnowledgeBudget, isKnowledgeLimitError } from "./knowledge-budget";
import { useLocale, useTranslations } from "next-intl";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api-client";
import { fill, without } from "@/lib/fill-field";
import { Button } from "./ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card";
import { ErrorText } from "./ui/form-field";
import { Input } from "./ui/input";
import { NativeSelect } from "./ui/native-select";
import { Textarea } from "./ui/textarea";
import { useConfirm } from "./ui/confirm-dialog";
// PARKED — site import (docs/phase-12-site-import.md §9)
// import { SiteImportCard } from "./site-import";
import {
  aiErrorKey,
  ContactDetailsCard,
  KnowledgeHealthCard,
  knowledgeHealthKey,
  useKnowledgeHealth,
} from "./knowledge-health";

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
  canManageContact,
  // canManageServices, — PARKED — site import (docs/phase-12-site-import.md §9)
  defaultLanguage,
  domain,
}: {
  tenantId: string;
  canManage: boolean;
  /** Service proposals from the website import are created through the catalogue. */
  canManageServices: boolean;
  /** The organization's website, which the import reads; null hides it. */
  domain: string | null;
  /** The language drafts are translated from (phase-12 §8.4). */
  defaultLanguage: string;
  /** Contact details and policies are tenant settings, not assistant ones. */
  canManageContact: boolean;
}) {
  const t = useTranslations("businessKnowledge");
  const locale = useLocale();
  const budgetText = useTranslations("knowledgeBudget");
  const [profileChanges, setProfileChanges] = useState<Partial<Record<Language, number>>>({});
  const [faqChanges, setFaqChanges] = useState<Partial<Record<Language, number>>>({});
  const client = useQueryClient();
  const healthText = useTranslations("knowledgeHealth");
  const { confirm, confirmDialog } = useConfirm();
  const profileForm = useRef<HTMLFormElement>(null);
  // Languages whose profile field holds an unedited machine draft.
  const [drafted, setDrafted] = useState<ReadonlySet<Language>>(new Set());
  // The default-language profile holds an unedited draft from the website.
  const [importedProfile, setImportedProfile] = useState(false);
  const [faqTarget, setFaqTarget] = useState<Language | null>(null);
  const [faqDraft, setFaqDraft] = useState<TranslationDraft | null>(null);
  const health = useKnowledgeHealth(tenantId);
  const profileFindings = (language: Language) =>
    health.data?.findings.filter(
      (finding) =>
        finding.source.kind === "PROFILE" &&
        finding.source.locale === language &&
        finding.acknowledgementId === null,
    ).length ?? 0;
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
      setDrafted(new Set());
      setImportedProfile(false);
      void client.invalidateQueries({ queryKey: ["knowledge-usage", tenantId] });
      void client.invalidateQueries({ queryKey: knowledgeHealthKey(tenantId) });
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
      void client.invalidateQueries({ queryKey: knowledgeHealthKey(tenantId) });
      void client.invalidateQueries({ queryKey: ["assistant-faqs", tenantId] });
    },
  });
  const removeFaq = useMutation({
    mutationFn: (id: string) =>
      apiFetch(`/v1/assistant/faqs/${id}`, { method: "DELETE", tenantId }),
    onSuccess: () => {
      setFaqChanges({});
      void client.invalidateQueries({ queryKey: ["knowledge-usage", tenantId] });
      void client.invalidateQueries({ queryKey: knowledgeHealthKey(tenantId) });
      void client.invalidateQueries({ queryKey: ["assistant-faqs", tenantId] });
    },
  });
  // phase-12 §8.4: a draft fills the editor and saves nothing.
  const draft = useMutation({
    mutationFn: (body: { target: Language; kind: "PROFILE" | "FAQ" }) =>
      apiFetch<TranslationDraft>("/v1/assistant/knowledge/translation-draft", {
        method: "POST",
        tenantId,
        body,
      }),
  });
  const sourceLanguage = LANGUAGES.find((language) => language === defaultLanguage) ?? "hu";
  const languageName = (language: Language) => t(LANGUAGE_LABELS[language]);
  // Hungarian writes language names in lower case mid-sentence ("a(z) magyar szövegből").
  const inSentence = (language: Language) =>
    locale === "hu" ? languageName(language).toLocaleLowerCase("hu") : languageName(language);
  const hasSourceProfile = Boolean(settings.data?.[PROFILE_FIELDS[sourceLanguage]]);
  const hasSourceFaqs = Boolean(faqs.data?.items.some((faq) => faq.locale === sourceLanguage));
  const otherLanguages = LANGUAGES.filter((language) => language !== sourceLanguage);
  const dropFaqDraft = (sourceId: string) =>
    setFaqDraft((current) =>
      current
        ? { ...current, faqs: current.faqs.filter((entry) => entry.sourceId !== sourceId) }
        : current,
    );

  /** Asks before replacing text already in a profile field, then lets `run` fill it. */
  const replaceProfile = (language: Language, run: (field: HTMLTextAreaElement) => void) => {
    const field = profileForm.current?.elements.namedItem(`description-${language}`);
    if (!(field instanceof HTMLTextAreaElement)) return;
    if (field.value.trim())
      confirm({
        title: t("draft.overwrite", { language: inSentence(language) }),
        confirmLabel: t("draft.replace"),
        onConfirm: () => run(field),
      });
    else run(field);
  };

  const draftProfile = (language: Language) =>
    replaceProfile(language, (field) =>
      draft.mutate(
        { target: language, kind: "PROFILE" },
        {
          onSuccess: (result) => {
            fill(field, result.profile ?? "");
            setDrafted((current) => new Set(current).add(language));
          },
        },
      ),
    );

  // PARKED — site import (docs/phase-12-site-import.md §9)
  // // docs/phase-12-site-import.md §4: the website draft goes into the same
  // // editor, saved by the same button, and is marked until the owner edits it.
  // const applyImportedProfile = (text: string) =>
  //   replaceProfile(sourceLanguage, (field) => {
  //     fill(field, text);
  //     setImportedProfile(true);
  //     field.scrollIntoView({ block: "center" });
  //   });

  return (
    <div className="grid items-start gap-6 lg:grid-cols-2">
      {confirmDialog}
      {/* PARKED — site import (docs/phase-12-site-import.md §9)
        {canManage && domain ? (
          <SiteImportCard
            tenantId={tenantId}
            domain={domain}
            language={sourceLanguage}
            canManageServices={canManageServices}
            onUseProfile={applyImportedProfile}
            onAddFaq={(faq, onDone) =>
              addFaq.mutate({ locale: sourceLanguage, ...faq }, { onSuccess: onDone })
            }
            addingFaq={addFaq.isPending}
          />
        ) : null}
      */}
      <KnowledgeHealthCard tenantId={tenantId} canManage={canManage} />
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
              ref={profileForm}
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
              {draft.isError && draft.variables?.kind === "PROFILE" ? (
                <ErrorText>{healthText(aiErrorKey(draft.error))}</ErrorText>
              ) : null}
              {LANGUAGES.map((language) => (
                <div key={language} className="grid gap-1">
                  <label>
                    {language.toUpperCase()} — {t("description")}
                    <Textarea
                      name={`description-${language}`}
                      lang={language}
                      defaultValue={settings.data[PROFILE_FIELDS[language]] ?? ""}
                      readOnly={!canManage}
                      aria-describedby={
                        drafted.has(language) || (importedProfile && language === sourceLanguage)
                          ? `draft-${language}`
                          : undefined
                      }
                      onInput={(event) => {
                        // Typing makes the draft the owner's text. `fill`
                        // dispatches an untrusted event, which does not count.
                        if (!event.nativeEvent.isTrusted) return;
                        setDrafted((current) => without(current, language));
                        if (language === sourceLanguage) setImportedProfile(false);
                      }}
                    />
                  </label>
                  {drafted.has(language) ? (
                    <p id={`draft-${language}`} className="text-sm text-warning">
                      {t("draft.marker", { language: inSentence(sourceLanguage) })}
                    </p>
                  ) : importedProfile && language === sourceLanguage ? (
                    <p id={`draft-${language}`} className="text-sm text-warning">
                      {t("import.marker", { domain: domain ?? "" })}
                    </p>
                  ) : null}
                  <div className="flex flex-wrap items-center gap-3">
                    {canManage && language !== sourceLanguage && hasSourceProfile ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={draft.isPending}
                        onClick={() => draftProfile(language)}
                      >
                        {draft.isPending &&
                        draft.variables.kind === "PROFILE" &&
                        draft.variables.target === language
                          ? t("draft.running")
                          : t("draft.profile", { language: inSentence(sourceLanguage) })}
                      </Button>
                    ) : null}
                    {profileFindings(language) > 0 ? (
                      <a href="#knowledge-health" className="text-sm text-warning underline">
                        {t("findings", { count: profileFindings(language) })}
                      </a>
                    ) : null}
                  </div>
                </div>
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
          {canManage && hasSourceFaqs ? (
            <div className="mt-4 grid gap-2 rounded-lg border border-line p-3">
              <p className="text-sm font-semibold">
                {t("draft.faqTitle", { language: inSentence(sourceLanguage) })}
              </p>
              <div className="flex flex-wrap items-end gap-2">
                <label className="grid gap-1 text-sm">
                  {t("draft.faqTarget")}
                  <NativeSelect
                    value={faqTarget ?? otherLanguages[0]}
                    onChange={(event) =>
                      setFaqTarget(
                        otherLanguages.find((language) => language === event.target.value) ?? null,
                      )
                    }
                  >
                    {otherLanguages.map((language) => (
                      <option key={language} value={language}>
                        {languageName(language)}
                      </option>
                    ))}
                  </NativeSelect>
                </label>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={draft.isPending}
                  onClick={() =>
                    draft.mutate(
                      { target: faqTarget ?? otherLanguages[0]!, kind: "FAQ" },
                      { onSuccess: setFaqDraft },
                    )
                  }
                >
                  {draft.isPending && draft.variables.kind === "FAQ"
                    ? t("draft.running")
                    : t("draft.faqRun")}
                </Button>
              </div>
              {draft.isError && draft.variables?.kind === "FAQ" ? (
                <ErrorText>{healthText(aiErrorKey(draft.error))}</ErrorText>
              ) : null}
              {faqDraft && faqDraft.faqs.length > 0 ? (
                <>
                  <p className="text-sm text-warning">
                    {t("draft.marker", { language: inSentence(sourceLanguage) })}
                  </p>
                  <ul className="grid gap-2">
                    {faqDraft.faqs.map((item) => (
                      <li
                        key={item.sourceId}
                        className="flex items-start justify-between gap-3 rounded-lg border border-dashed border-line p-3"
                      >
                        <div lang={faqDraft.target}>
                          <span className="text-xs text-ink-muted">
                            {languageName(faqDraft.target)}
                          </span>
                          <p className="font-semibold">{item.question}</p>
                          <p className="text-sm text-ink-muted">{item.answer}</p>
                        </div>
                        <div className="flex gap-1">
                          <Button
                            type="button"
                            size="sm"
                            disabled={addFaq.isPending}
                            onClick={() =>
                              addFaq.mutate(
                                {
                                  locale: faqDraft.target,
                                  question: item.question,
                                  answer: item.answer,
                                },
                                { onSuccess: () => dropFaqDraft(item.sourceId) },
                              )
                            }
                          >
                            {t("draft.add")}
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => dropFaqDraft(item.sourceId)}
                          >
                            {t("draft.discard")}
                          </Button>
                        </div>
                      </li>
                    ))}
                  </ul>
                </>
              ) : null}
            </div>
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
      <ContactDetailsCard tenantId={tenantId} canManage={canManageContact} />
    </div>
  );
}
