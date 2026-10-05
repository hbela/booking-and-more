"use client";

import { PageLoading } from "./ui/loading";
import { knowledgeCharacters, type Language, type TranslationDraft } from "@bam/contracts";
import { KnowledgeBudget, isKnowledgeLimitError } from "./knowledge-budget";
import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import {
  ApiError,
  apiFetch,
  formatMoney,
  type Paginated,
  type Service,
  type ServiceDetail,
} from "@/lib/api-client";
import { LOCALES, diffPatch } from "@/lib/catalogue-form";
import { fill, without } from "@/lib/fill-field";
import { aiErrorKey } from "./knowledge-health";
import { useConfirm } from "./ui/confirm-dialog";
import {
  ServiceFields,
  serviceBodyFrom,
  serviceStateFrom,
  type ServiceFormState,
} from "./service-fields";
import { DashboardShell, useDashboardContext, useSignInRedirect } from "./dashboard-shell";
import { NoOrganizationPanel } from "./no-organization";
import { type EditPanel, useEditPanel } from "@/lib/use-edit-panel";
import { Button } from "./ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import { ErrorText, FormField } from "./ui/form-field";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";
import { Section } from "./ui/section";
import {
  RowButton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "./ui/table";
import { Checkbox } from "./ui/checkbox";

/** A trimmed text value from a form. `FormData.get` can also hand back a File,
 *  which would stringify to "[object Object]" if taken at face value. */
function textField(data: FormData, key: string): string {
  const value = data.get(key);
  return typeof value === "string" ? value.trim() : "";
}

export function ServicesScreen(): React.ReactElement {
  const t = useTranslations("catalogue");
  const locale = useLocale();
  const context = useDashboardContext();
  useSignInRedirect(!context.isPending && !context.me);
  const queryClient = useQueryClient();

  const [translating, setTranslating] = useState<Service | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const edit = useEditPanel("service");

  const canManage = context.can("service:manage");

  const services = useQuery({
    // The flag joins the key: two different questions, two different answers.
    queryKey: ["services", context.tenantId, showArchived],
    queryFn: () =>
      apiFetch<Paginated<Service>>(
        `/v1/services?limit=100${showArchived ? "&includeArchived=true" : ""}`,
        { tenantId: context.tenantId },
      ),
    enabled: Boolean(context.tenantId),
  });

  const editing = services.data?.items.find((service) => service.id === edit.openId);

  // A signed-out visitor is redirected from an effect, not from render.
  if (context.isPending || !context.me) {
    return <PageLoading label={t("loading")} />;
  }

  // Signed in, but there is no organization to scope this screen to. Every
  // query below is gated on `context.tenantId`, so without this the shell
  // renders around a body that never fills (see no-organization.tsx).
  if (context.hasNoOrganization) {
    return (
      <DashboardShell context={context}>
        <NoOrganizationPanel isPlatformAdmin={context.me.user.isPlatformAdmin} />
      </DashboardShell>
    );
  }

  return (
    <DashboardShell context={context}>
      <Section title={t("services")}>
        {/* A filter rather than a second table: the owner's model is "my
            services, including the ones I put away", not two catalogues. */}
        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={showArchived}
            onCheckedChange={(value) => {
              setShowArchived(value === true);
            }}
          />
          <span>{t("showArchived")}</span>
        </label>

        {services.data?.items.length === 0 ? (
          <p className="text-sm text-ink-muted">{t("noServices")}</p>
        ) : (
          <Table className="w-full min-w-md">
            <TableHeader>
              <TableRow>
                <TableHead>{t("name")}</TableHead>
                <TableHead>{t("duration")}</TableHead>
                <TableHead>{t("price")}</TableHead>
                <TableHead>{t("status")}</TableHead>
                <TableHead>
                  <span className="sr-only">{t("actions")}</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {services.data?.items.map((service) => {
                const archived = service.archivedAt !== null;

                return (
                  <TableRow key={service.id}>
                    <TableCell className={archived ? "text-ink-subtle" : undefined}>
                      {service.name}
                      <span className="block font-mono text-xs text-ink-subtle">
                        {service.slug}
                      </span>
                    </TableCell>
                    <TableCell>{t("minutes", { count: service.durationMinutes })}</TableCell>
                    <TableCell>
                      {service.priceMinor === null || service.currency === null
                        ? t("onRequest")
                        : formatMoney(service.priceMinor, service.currency, locale)}
                    </TableCell>
                    <TableCell>
                      {archived ? t("archived") : service.active ? t("active") : t("inactive")}
                    </TableCell>
                    <TableCell>
                      {!canManage ? null : archived ? (
                        // Restore is the only action on an archived row —
                        // editing or activating one in place would be a way
                        // of half-reviving it.
                        <RowButton
                          onClick={() => {
                            void apiFetch(`/v1/services/${service.id}/restore`, {
                              method: "POST",
                              tenantId: context.tenantId,
                            }).then(() => {
                              void queryClient.invalidateQueries({ queryKey: ["services"] });
                              void queryClient.invalidateQueries({
                                queryKey: ["knowledge-usage"],
                              });
                            });
                          }}
                        >
                          {t("restore")}
                        </RowButton>
                      ) : (
                        <div className="flex flex-wrap gap-2">
                          <RowButton
                            onClick={() => {
                              edit.toggle(service.id);
                            }}
                            {...edit.triggerProps(service.id)}
                          >
                            {t("edit")}
                          </RowButton>
                          <RowButton
                            onClick={() => {
                              setTranslating(translating?.id === service.id ? null : service);
                            }}
                          >
                            {t("translations")}
                          </RowButton>
                          <RowButton
                            onClick={() => {
                              void apiFetch(`/v1/services/${service.id}`, {
                                method: "PATCH",
                                tenantId: context.tenantId,
                                body: { active: !service.active },
                              }).then(() => {
                                void queryClient.invalidateQueries({ queryKey: ["services"] });
                                void queryClient.invalidateQueries({
                                  queryKey: ["knowledge-usage"],
                                });
                              });
                            }}
                          >
                            {service.active ? t("deactivate") : t("activate")}
                          </RowButton>
                          <RowButton
                            onClick={() => {
                              void apiFetch(`/v1/services/${service.id}`, {
                                method: "DELETE",
                                tenantId: context.tenantId,
                              }).then(() => {
                                void queryClient.invalidateQueries({ queryKey: ["services"] });
                                void queryClient.invalidateQueries({
                                  queryKey: ["knowledge-usage"],
                                });
                              });
                            }}
                          >
                            {t("archive")}
                          </RowButton>
                        </div>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </Section>

      {editing && context.tenantId ? (
        <EditServicePanel
          key={editing.id}
          tenantId={context.tenantId}
          service={editing}
          panelProps={edit.panelProps}
          onClose={edit.close}
        />
      ) : null}

      {translating && context.tenantId ? (
        <TranslationsPanel
          key={`${context.tenantId}-${translating.id}`}
          tenantId={context.tenantId}
          defaultLanguage={context.me.tenant?.defaultLanguage ?? "hu"}
          // A draft is a paid model call on the assistant's allowance, so it
          // carries the assistant's guard and plan (phase-12 §8.4).
          canDraft={context.me.features.assistant && context.can("assistant:manage")}
          service={translating}
          onClose={() => {
            setTranslating(null);
          }}
        />
      ) : null}

      {canManage && context.tenantId ? <CreateServicePanel tenantId={context.tenantId} /> : null}
    </DashboardShell>
  );
}

function CreateServicePanel({ tenantId }: { tenantId: string }): React.ReactElement {
  const t = useTranslations("catalogue");
  const budgetText = useTranslations("knowledgeBudget");
  const queryClient = useQueryClient();

  const [state, setState] = useState<ServiceFormState>(() => serviceStateFrom());
  const [error, setError] = useState<string | null>(null);
  const [slugTaken, setSlugTaken] = useState(false);

  const mutation = useMutation({
    mutationFn: () =>
      apiFetch<Service>("/v1/services", {
        method: "POST",
        tenantId,
        body: serviceBodyFrom(state, "create"),
      }),
    onSuccess: () => {
      setState(serviceStateFrom());
      void queryClient.invalidateQueries({ queryKey: ["services"] });
      void queryClient.invalidateQueries({ queryKey: ["knowledge-usage"] });
    },
    onError: (cause: unknown) => {
      // The slug index covers archived rows, so this error usually means the
      // name is held by something the owner archived — and cannot see. Saying
      // so turns the most confusing possible failure into an instruction.
      setSlugTaken(cause instanceof ApiError && cause.code === "SLUG_TAKEN");
      setError(
        isKnowledgeLimitError(cause)
          ? budgetText("error")
          : cause instanceof ApiError
            ? cause.message
            : t("genericError"),
      );
    },
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("addService")}</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-ink-muted">{t("addServiceHint")}</p>

        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            setError(null);
            setSlugTaken(false);
            mutation.mutate();
          }}
        >
          <ServiceFields
            state={state}
            idPrefix="new-service"
            onChange={(patch) => {
              setState((current) => ({ ...current, ...patch }));
            }}
          />

          <KnowledgeBudget
            tenantId={tenantId}
            baseDescriptionChange={knowledgeCharacters(state.description)}
          />
          <ErrorText>{error}</ErrorText>
          {slugTaken ? (
            <p className="text-sm text-ink-muted">{t("slugTakenArchivedHint")}</p>
          ) : null}

          <Button type="submit" disabled={mutation.isPending}>
            {t("create")}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

/**
 * Editing a service.
 *
 * Sends a diff rather than the whole body: catalogue rows carry no `version`
 * column, so a full-body PATCH would silently overwrite whatever a colleague
 * changed since this panel opened.
 */
function EditServicePanel({
  tenantId,
  service,
  panelProps,
  onClose,
}: {
  tenantId: string;
  service: Service;
  panelProps: EditPanel["panelProps"];
  onClose: () => void;
}): React.ReactElement {
  const t = useTranslations("catalogue");
  const budgetText = useTranslations("knowledgeBudget");
  const queryClient = useQueryClient();

  const original = serviceStateFrom(service);
  const [state, setState] = useState<ServiceFormState>(original);
  const [error, setError] = useState<string | null>(null);

  // Who offers this service. Read-only here on purpose: assignments are written
  // from the provider side only, because a second whole-set writer over
  // `provider_services` would clobber the first with nothing to notice it.
  const detail = useQuery({
    queryKey: ["service", service.id],
    queryFn: () => apiFetch<ServiceDetail>(`/v1/services/${service.id}`, { tenantId }),
  });

  const save = useMutation({
    mutationFn: () =>
      apiFetch<Service>(`/v1/services/${service.id}`, {
        method: "PATCH",
        tenantId,
        body: diffPatch(serviceBodyFrom(original, "patch"), serviceBodyFrom(state, "patch")),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["services"] });
      void queryClient.invalidateQueries({ queryKey: ["knowledge-usage"] });
      onClose();
    },
    onError: (cause: unknown) => {
      setError(
        isKnowledgeLimitError(cause)
          ? budgetText("error")
          : cause instanceof ApiError
            ? cause.message
            : t("genericError"),
      );
    },
  });

  return (
    <Card {...panelProps}>
      <CardHeader>
        <CardTitle>{t("editService")}</CardTitle>
      </CardHeader>
      <CardContent>
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            setError(null);
            save.mutate();
          }}
        >
          <ServiceFields
            state={state}
            idPrefix={`edit-service-${service.id}`}
            onChange={(patch) => {
              setState((current) => ({ ...current, ...patch }));
            }}
          />

          <KnowledgeBudget
            tenantId={tenantId}
            baseDescriptionChange={
              knowledgeCharacters(state.description) - knowledgeCharacters(service.description)
            }
          />
          <div className="flex flex-col gap-1">
            <span className="text-sm font-medium">{t("offeredBy")}</span>
            {detail.data === undefined ? null : detail.data.providers.length === 0 ? (
              <p className="text-sm text-ink-muted">{t("noProvidersAssigned")}</p>
            ) : (
              <ul className="text-sm text-ink-muted">
                {detail.data.providers.map((entry) => (
                  <li key={entry.providerId}>
                    {entry.displayName}
                    {entry.active ? "" : ` · ${t("inactive")}`}
                  </li>
                ))}
              </ul>
            )}
            <p className="text-xs text-ink-subtle">{t("offeredByHint")}</p>
          </div>

          <ErrorText>{error}</ErrorText>

          <div className="flex gap-3">
            <Button type="submit" disabled={save.isPending}>
              {t("saveChanges")}
            </Button>
            <Button variant="outline" type="button" onClick={onClose}>
              {t("cancel")}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

/**
 * Tenant-managed service translations (tech-impl §38).
 *
 * The original language is edited in the main service form. Translations remain
 * editable so owners can reduce existing content. Preserve the disabled
 * original-language entry when replacing the set.
 */
const LANGUAGE_LABELS = { hu: "hungarian", en: "english", de: "german", fr: "french" } as const;

function TranslationsPanel({
  tenantId,
  defaultLanguage,
  canDraft,
  service,
  onClose,
}: {
  tenantId: string;
  defaultLanguage: string;
  /** Machine drafts from the default language (docs/phase-12-service-translation-drafts.md). */
  canDraft: boolean;
  service: Service;
  onClose: () => void;
}): React.ReactElement {
  const t = useTranslations("catalogue");
  const knowledgeText = useTranslations("businessKnowledge");
  const healthText = useTranslations("knowledgeHealth");
  const budgetText = useTranslations("knowledgeBudget");
  const uiLocale = useLocale();
  const queryClient = useQueryClient();
  const { confirm, confirmDialog } = useConfirm();
  const formRef = useRef<HTMLFormElement>(null);
  const [error, setError] = useState<string | null>(null);
  // Locales whose fields hold an unedited machine draft.
  const [drafted, setDrafted] = useState<ReadonlySet<Language>>(new Set());

  const sourceLanguage = LOCALES.find((entry) => entry === defaultLanguage) ?? "hu";
  // Hungarian writes language names in lower case mid-sentence ("a(z) magyar szövegből").
  const inSentence = (language: Language) => {
    const name = knowledgeText(LANGUAGE_LABELS[language]);
    return uiLocale === "hu" ? name.toLocaleLowerCase("hu") : name;
  };

  // phase-12 §8.4: a draft fills the editor and saves nothing.
  const draft = useMutation({
    mutationFn: (target: Language) =>
      apiFetch<TranslationDraft>("/v1/assistant/knowledge/translation-draft", {
        method: "POST",
        tenantId,
        body: { target, kind: "SERVICE", serviceId: service.id },
      }),
  });

  const draftLocale = (language: Language) => {
    const form = formRef.current;
    const name = form?.elements.namedItem(`name-${language}`);
    const description = form?.elements.namedItem(`description-${language}`);
    if (!(name instanceof HTMLInputElement) || !(description instanceof HTMLTextAreaElement))
      return;
    const run = () =>
      draft.mutate(language, {
        onSuccess: (result) => {
          if (!result.service) return;
          fill(name, result.service.name);
          fill(description, result.service.description ?? "");
          setDrafted((current) => new Set(current).add(language));
        },
      });
    if (name.value.trim() || description.value.trim())
      confirm({
        title: t("draftOverwrite", { language: inSentence(language) }),
        confirmLabel: knowledgeText("draft.replace"),
        onConfirm: run,
      });
    else run();
  };
  // Typing makes the draft the owner's text. `fill` dispatches an untrusted
  // event, which does not count.
  const ownEdit = (language: Language) => (event: React.FormEvent) => {
    if (event.nativeEvent.isTrusted) setDrafted((current) => without(current, language));
  };

  const [changes, setChanges] = useState<Partial<Record<Language, number>>>({});
  const save = useMutation({
    mutationFn: (form: HTMLFormElement) => {
      const data = new FormData(form);

      const translations = LOCALES.flatMap((locale) => {
        const existing = service.translations.find((entry) => entry.locale === locale);
        if (locale === defaultLanguage) return existing ? [existing] : [];

        const name = textField(data, `name-${locale}`);
        // A blank name means "no translation for this locale", and the whole
        // entry is dropped rather than stored as an empty string.
        if (name === "") return [];

        const description = textField(data, `description-${locale}`);
        return [{ locale, name, description: description === "" ? null : description }];
      });

      return apiFetch(`/v1/services/${service.id}/translations`, {
        method: "PUT",
        tenantId,
        body: { translations },
      });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["services"] });
      void queryClient.invalidateQueries({ queryKey: ["knowledge-usage"] });
      onClose();
    },
    onError: (cause: unknown) => {
      setError(
        isKnowledgeLimitError(cause)
          ? budgetText("error")
          : cause instanceof ApiError
            ? cause.message
            : t("genericError"),
      );
    },
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("translationsFor", { name: service.name })}</CardTitle>
      </CardHeader>
      <CardContent>
        {confirmDialog}
        <form
          ref={formRef}
          onChange={(event) => {
            const data = new FormData(event.currentTarget);
            setChanges(
              Object.fromEntries(
                LOCALES.filter((locale) => locale !== defaultLanguage).map((locale) => [
                  locale,
                  (textField(data, `name-${locale}`)
                    ? knowledgeCharacters(textField(data, `description-${locale}`))
                    : 0) -
                    knowledgeCharacters(
                      service.translations.find((entry) => entry.locale === locale)?.description,
                    ),
                ]),
              ),
            );
          }}
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            setError(null);
            save.mutate(event.currentTarget);
          }}
        >
          {LOCALES.map((locale) => {
            const existing = service.translations.find((entry) => entry.locale === locale);
            const isOriginal = locale === defaultLanguage;
            const locked = isOriginal;
            const markerId = `draft-${locale}`;

            return (
              <div key={locale} className="flex flex-col gap-2">
                <div className="flex flex-wrap items-end gap-2">
                  <div className="min-w-0 flex-1">
                    <FormField
                      id={`name-${locale}`}
                      label={`${locale.toUpperCase()} — ${t("name")}`}
                    >
                      <Input
                        id={`name-${locale}`}
                        name={`name-${locale}`}
                        lang={locale}
                        defaultValue={existing?.name ?? (isOriginal ? service.name : "")}
                        placeholder={service.name}
                        disabled={locked}
                        aria-describedby={drafted.has(locale) ? markerId : undefined}
                        onInput={ownEdit(locale)}
                      />
                    </FormField>
                  </div>
                  {canDraft && !isOriginal ? (
                    // Outside the label, so it is not part of the field's accessible name.
                    <Button
                      type="button"
                      variant="outline"
                      disabled={draft.isPending}
                      onClick={() => draftLocale(locale)}
                    >
                      {draft.isPending && draft.variables === locale
                        ? knowledgeText("draft.running")
                        : knowledgeText("draft.profile", { language: inSentence(sourceLanguage) })}
                    </Button>
                  ) : null}
                </div>
                {drafted.has(locale) ? (
                  <p id={markerId} className="text-sm text-warning">
                    {knowledgeText("draft.marker", { language: inSentence(sourceLanguage) })}
                  </p>
                ) : null}
                {draft.isError && draft.variables === locale ? (
                  <ErrorText>{healthText(aiErrorKey(draft.error))}</ErrorText>
                ) : null}

                <FormField
                  id={`description-${locale}`}
                  label={`${locale.toUpperCase()} — ${t("description")}`}
                  hint={t("serviceDescriptionHint")}
                >
                  <Textarea
                    id={`description-${locale}`}
                    aria-describedby={
                      drafted.has(locale)
                        ? `description-${locale}-hint ${markerId}`
                        : `description-${locale}-hint`
                    }
                    rows={5}
                    lang={locale}
                    onInput={ownEdit(locale)}
                    name={`description-${locale}`}
                    defaultValue={
                      existing?.description ?? (isOriginal ? (service.description ?? "") : "")
                    }
                    disabled={locked}
                  />
                </FormField>
              </div>
            );
          })}

          <KnowledgeBudget tenantId={tenantId} changes={changes} />
          <ErrorText>{error}</ErrorText>

          <div className="flex gap-3">
            <Button type="submit" disabled={save.isPending}>
              {t("save")}
            </Button>
            <Button variant="outline" type="button" onClick={onClose}>
              {t("cancel")}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
