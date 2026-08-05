"use client";

import { useState } from "react";
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
import {
  ServiceFields,
  serviceBodyFrom,
  serviceStateFrom,
  type ServiceFormState,
} from "./service-fields";
import {
  DashboardShell,
  ErrorText,
  Field,
  Panel,
  RowButton,
  Section,
  buttonClass,
  inputClass,
  secondaryButtonClass,
  useDashboardContext,
  useEditPanel,
  useSignInRedirect,
  type EditPanel,
} from "./dashboard-shell";

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
    return <p className="p-8">{t("loading")}</p>;
  }

  return (
    <DashboardShell context={context}>
      <Section title={t("services")}>
        {/* A filter rather than a second table: the owner's model is "my
            services, including the ones I put away", not two catalogues. */}
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={showArchived}
            onChange={(event) => {
              setShowArchived(event.target.checked);
            }}
          />
          <span>{t("showArchived")}</span>
        </label>

        {services.data?.items.length === 0 ? (
          <p className="text-sm text-slate-600 dark:text-slate-400">{t("noServices")}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-md text-left text-sm">
              <thead className="border-b border-slate-200 dark:border-slate-800">
                <tr>
                  <th scope="col" className="py-2 pr-4 font-medium">
                    {t("name")}
                  </th>
                  <th scope="col" className="py-2 pr-4 font-medium">
                    {t("duration")}
                  </th>
                  <th scope="col" className="py-2 pr-4 font-medium">
                    {t("price")}
                  </th>
                  <th scope="col" className="py-2 pr-4 font-medium">
                    {t("status")}
                  </th>
                  <th scope="col" className="py-2 font-medium">
                    <span className="sr-only">{t("actions")}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {services.data?.items.map((service) => {
                  const archived = service.archivedAt !== null;

                  return (
                    <tr key={service.id} className="border-b border-slate-100 dark:border-slate-900">
                      <td className={`py-2 pr-4 ${archived ? "text-slate-500" : ""}`}>
                        {service.name}
                        <span className="block font-mono text-xs text-slate-500">
                          {service.slug}
                        </span>
                      </td>
                      <td className="py-2 pr-4">
                        {t("minutes", { count: service.durationMinutes })}
                      </td>
                      <td className="py-2 pr-4">
                        {service.priceMinor === null || service.currency === null
                          ? t("onRequest")
                          : formatMoney(service.priceMinor, service.currency, locale)}
                      </td>
                      <td className="py-2 pr-4">
                        {archived ? t("archived") : service.active ? t("active") : t("inactive")}
                      </td>
                      <td className="py-2">
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
                                });
                              }}
                            >
                              {t("archive")}
                            </RowButton>
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
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
          tenantId={context.tenantId}
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
    },
    onError: (cause: unknown) => {
      // The slug index covers archived rows, so this error usually means the
      // name is held by something the owner archived — and cannot see. Saying
      // so turns the most confusing possible failure into an instruction.
      setSlugTaken(cause instanceof ApiError && cause.code === "SLUG_TAKEN");
      setError(cause instanceof ApiError ? cause.message : t("genericError"));
    },
  });

  return (
    <Panel title={t("addService")}>
      <p className="text-sm text-slate-600 dark:text-slate-400">{t("addServiceHint")}</p>

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

        <ErrorText>{error}</ErrorText>
        {slugTaken ? (
          <p className="text-sm text-slate-600 dark:text-slate-400">
            {t("slugTakenArchivedHint")}
          </p>
        ) : null}

        <button type="submit" disabled={mutation.isPending} className={buttonClass}>
          {t("create")}
        </button>
      </form>
    </Panel>
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
      onClose();
    },
    onError: (cause: unknown) => {
      setError(cause instanceof ApiError ? cause.message : t("genericError"));
    },
  });

  return (
    <Panel title={t("editService")} {...panelProps}>
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

        <div className="flex flex-col gap-1">
          <span className="text-sm font-medium">{t("offeredBy")}</span>
          {detail.data === undefined ? null : detail.data.providers.length === 0 ? (
            <p className="text-sm text-slate-600 dark:text-slate-400">
              {t("noProvidersAssigned")}
            </p>
          ) : (
            <ul className="text-sm text-slate-600 dark:text-slate-400">
              {detail.data.providers.map((entry) => (
                <li key={entry.providerId}>
                  {entry.displayName}
                  {entry.active ? "" : ` · ${t("inactive")}`}
                </li>
              ))}
            </ul>
          )}
          <p className="text-xs text-slate-500">{t("offeredByHint")}</p>
        </div>

        <ErrorText>{error}</ErrorText>

        <div className="flex gap-3">
          <button type="submit" disabled={save.isPending} className={buttonClass}>
            {t("saveChanges")}
          </button>
          <button type="button" onClick={onClose} className={secondaryButtonClass}>
            {t("cancel")}
          </button>
        </div>
      </form>
    </Panel>
  );
}

/**
 * Tenant-managed service translations (tech-impl §38).
 *
 * Every supported locale is shown at once and submitted as a whole set, because
 * that is what the API's `PUT` means. A blank name is treated as "no
 * translation" and the locale falls back to the service's own name — which is
 * the behaviour a reader wants anyway.
 */
function TranslationsPanel({
  tenantId,
  service,
  onClose,
}: {
  tenantId: string;
  service: Service;
  onClose: () => void;
}): React.ReactElement {
  const t = useTranslations("catalogue");
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: (form: HTMLFormElement) => {
      const data = new FormData(form);

      const translations = LOCALES.flatMap((locale) => {
        const name = textField(data, `name-${locale}`);
        // A blank name means "no translation for this locale", and the whole
        // entry is dropped rather than stored as an empty string.
        if (name === "") return [];

        const description = textField(data, `description-${locale}`);
        return [{ locale, name, ...(description === "" ? {} : { description }) }];
      });

      return apiFetch(`/v1/services/${service.id}/translations`, {
        method: "PUT",
        tenantId,
        body: { translations },
      });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["services"] });
      onClose();
    },
    onError: (cause: unknown) => {
      setError(cause instanceof ApiError ? cause.message : t("genericError"));
    },
  });

  return (
    <Panel title={t("translationsFor", { name: service.name })}>
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          setError(null);
          save.mutate(event.currentTarget);
        }}
      >
        {LOCALES.map((locale) => {
          const existing = service.translations.find((entry) => entry.locale === locale);

          return (
            <div key={locale} className="flex flex-col gap-2">
              <Field id={`name-${locale}`} label={`${locale.toUpperCase()} — ${t("name")}`}>
                <input
                  id={`name-${locale}`}
                  name={`name-${locale}`}
                  defaultValue={existing?.name ?? ""}
                  placeholder={service.name}
                  className={inputClass}
                />
              </Field>

              <Field
                id={`description-${locale}`}
                label={`${locale.toUpperCase()} — ${t("description")}`}
              >
                <input
                  id={`description-${locale}`}
                  name={`description-${locale}`}
                  defaultValue={existing?.description ?? ""}
                  className={inputClass}
                />
              </Field>
            </div>
          );
        })}

        <ErrorText>{error}</ErrorText>

        <div className="flex gap-3">
          <button type="submit" disabled={save.isPending} className={buttonClass}>
            {t("save")}
          </button>
          <button type="button" onClick={onClose} className={secondaryButtonClass}>
            {t("cancel")}
          </button>
        </div>
      </form>
    </Panel>
  );
}
