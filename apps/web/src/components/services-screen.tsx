"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import {
  ApiError,
  apiFetch,
  formatMoney,
  toMinorUnits,
  type Paginated,
  type Service,
} from "@/lib/api-client";
import {
  DashboardShell,
  ErrorText,
  Field,
  Panel,
  Section,
  buttonClass,
  inputClass,
  useDashboardContext,
  useSignInRedirect,
} from "./dashboard-shell";

/** The locales a tenant can translate a service into. Mirrors `languageSchema`
 *  in @bam/contracts; the API rejects anything else. */
const LOCALES = ["hu", "en", "de", "fr"] as const;

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

  const canManage = context.can("service:manage");

  const services = useQuery({
    queryKey: ["services", context.tenantId],
    queryFn: () =>
      apiFetch<Paginated<Service>>("/v1/services?limit=100", { tenantId: context.tenantId }),
    enabled: Boolean(context.tenantId),
  });

  // A signed-out visitor is redirected from an effect, not from render.
  if (context.isPending || !context.me) {
    return <p className="p-8">{t("loading")}</p>;
  }

  return (
    <DashboardShell context={context}>
      <Section title={t("services")}>
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
                {services.data?.items.map((service) => (
                  <tr key={service.id} className="border-b border-slate-100 dark:border-slate-900">
                    <td className="py-2 pr-4">
                      {service.name}
                      <span className="block font-mono text-xs text-slate-500">{service.slug}</span>
                    </td>
                    <td className="py-2 pr-4">
                      {t("minutes", { count: service.durationMinutes })}
                    </td>
                    <td className="py-2 pr-4">
                      {service.priceMinor === null || service.currency === null
                        ? t("onRequest")
                        : formatMoney(service.priceMinor, service.currency, locale)}
                    </td>
                    <td className="py-2 pr-4">{service.active ? t("active") : t("inactive")}</td>
                    <td className="py-2">
                      {canManage ? (
                        <div className="flex flex-wrap gap-2">
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
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

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

function RowButton({
  onClick,
  children,
}: {
  onClick: () => void;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-md border border-slate-300 px-2 py-1 text-xs dark:border-slate-700"
    >
      {children}
    </button>
  );
}

function CreateServicePanel({ tenantId }: { tenantId: string }): React.ReactElement {
  const t = useTranslations("catalogue");
  const queryClient = useQueryClient();

  const [name, setName] = useState("");
  const [durationMinutes, setDurationMinutes] = useState("30");
  const [price, setPrice] = useState("");
  const [currency, setCurrency] = useState("HUF");
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () =>
      apiFetch<Service>("/v1/services", {
        method: "POST",
        tenantId,
        body: {
          name,
          durationMinutes: Number(durationMinutes),
          // A blank price means "on request", which is not the same as free —
          // so the field is omitted rather than sent as 0.
          ...(price === "" ? {} : { priceMinor: toMinorUnits(Number(price), currency), currency }),
        },
      }),
    onSuccess: () => {
      setName("");
      setPrice("");
      void queryClient.invalidateQueries({ queryKey: ["services"] });
    },
    onError: (cause: unknown) => {
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
          mutation.mutate();
        }}
      >
        <Field id="service-name" label={t("name")}>
          <input
            id="service-name"
            value={name}
            onChange={(event) => {
              setName(event.target.value);
            }}
            required
            minLength={2}
            className={inputClass}
          />
        </Field>

        <Field id="service-duration" label={t("durationMinutes")}>
          <input
            id="service-duration"
            type="number"
            min={5}
            max={1440}
            step={5}
            value={durationMinutes}
            onChange={(event) => {
              setDurationMinutes(event.target.value);
            }}
            required
            className={inputClass}
          />
        </Field>

        <div className="flex flex-wrap gap-3">
          <Field id="service-price" label={t("priceOptional")}>
            <input
              id="service-price"
              type="number"
              min={0}
              step="0.01"
              value={price}
              onChange={(event) => {
                setPrice(event.target.value);
              }}
              className={inputClass}
            />
          </Field>

          <Field id="service-currency" label={t("currency")}>
            <select
              id="service-currency"
              value={currency}
              onChange={(event) => {
                setCurrency(event.target.value);
              }}
              className={inputClass}
            >
              {["HUF", "EUR", "USD", "GBP"].map((code) => (
                <option key={code} value={code}>
                  {code}
                </option>
              ))}
            </select>
          </Field>
        </div>

        <ErrorText>{error}</ErrorText>

        <button type="submit" disabled={mutation.isPending} className={buttonClass}>
          {t("create")}
        </button>
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
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-slate-300 px-4 py-2 text-sm dark:border-slate-700"
          >
            {t("cancel")}
          </button>
        </div>
      </form>
    </Panel>
  );
}
