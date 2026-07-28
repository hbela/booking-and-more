"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import {
  ApiError,
  apiFetch,
  type AssignedLocation,
  type AssignedService,
  type Location,
  type Paginated,
  type Provider,
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

/**
 * Providers screen. tech-impl §28.
 *
 * Controls appear only when `me.permissions` says the caller may use them —
 * which is a UI affordance and nothing more. Every action is authorised again
 * server-side, so hiding a button is never what stops an unauthorised call.
 */
export function ProvidersScreen(): React.ReactElement {
  const t = useTranslations("catalogue");
  const context = useDashboardContext();
  useSignInRedirect(!context.isPending && !context.me);
  const queryClient = useQueryClient();

  const [editing, setEditing] = useState<string | null>(null);

  const canManage = context.can("provider:manage");

  const providers = useQuery({
    queryKey: ["providers", context.tenantId],
    queryFn: () =>
      apiFetch<Paginated<Provider>>("/v1/providers?limit=100", { tenantId: context.tenantId }),
    enabled: Boolean(context.tenantId),
  });

  // A signed-out visitor is redirected from an effect, not from render.
  if (context.isPending || !context.me) {
    return <p className="p-8">{t("loading")}</p>;
  }

  return (
    <DashboardShell context={context}>
      <Section title={t("providers")}>
        {providers.data?.items.length === 0 ? (
          <p className="text-sm text-slate-600 dark:text-slate-400">{t("noProviders")}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-md text-left text-sm">
              <thead className="border-b border-slate-200 dark:border-slate-800">
                <tr>
                  <th scope="col" className="py-2 pr-4 font-medium">
                    {t("name")}
                  </th>
                  <th scope="col" className="py-2 pr-4 font-medium">
                    {t("timezone")}
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
                {providers.data?.items.map((provider) => (
                  <tr key={provider.id} className="border-b border-slate-100 dark:border-slate-900">
                    <td className="py-2 pr-4">{provider.displayName}</td>
                    <td className="py-2 pr-4 text-slate-600 dark:text-slate-400">
                      {provider.timezone}
                    </td>
                    <td className="py-2 pr-4">
                      {provider.active ? t("active") : t("inactive")}
                      {provider.onlineBookingEnabled ? "" : ` · ${t("offlineOnly")}`}
                    </td>
                    <td className="py-2">
                      {canManage ? (
                        <div className="flex flex-wrap gap-2">
                          <RowButton
                            onClick={() => {
                              setEditing(editing === provider.id ? null : provider.id);
                            }}
                          >
                            {t("assign")}
                          </RowButton>
                          <RowButton
                            onClick={() => {
                              void apiFetch(`/v1/providers/${provider.id}`, {
                                method: "PATCH",
                                tenantId: context.tenantId,
                                body: { active: !provider.active },
                              }).then(() => {
                                void queryClient.invalidateQueries({ queryKey: ["providers"] });
                              });
                            }}
                          >
                            {provider.active ? t("deactivate") : t("activate")}
                          </RowButton>
                          <RowButton
                            onClick={() => {
                              void apiFetch(`/v1/providers/${provider.id}`, {
                                method: "DELETE",
                                tenantId: context.tenantId,
                              }).then(() => {
                                void queryClient.invalidateQueries({ queryKey: ["providers"] });
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

      {editing && context.tenantId ? (
        <AssignmentsPanel
          tenantId={context.tenantId}
          providerId={editing}
          onClose={() => {
            setEditing(null);
          }}
        />
      ) : null}

      {canManage && context.tenantId ? <CreateProviderPanel tenantId={context.tenantId} /> : null}
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

function CreateProviderPanel({ tenantId }: { tenantId: string }): React.ReactElement {
  const t = useTranslations("catalogue");
  const queryClient = useQueryClient();
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () =>
      apiFetch<Provider>("/v1/providers", {
        method: "POST",
        tenantId,
        // An empty email field means "not given", not an empty string — the API
        // would reject "" as a malformed address.
        body: { displayName, ...(email === "" ? {} : { email }) },
      }),
    onSuccess: () => {
      setDisplayName("");
      setEmail("");
      void queryClient.invalidateQueries({ queryKey: ["providers"] });
    },
    onError: (cause: unknown) => {
      setError(cause instanceof ApiError ? cause.message : t("genericError"));
    },
  });

  return (
    <Panel title={t("addProvider")}>
      <p className="text-sm text-slate-600 dark:text-slate-400">{t("addProviderHint")}</p>

      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          setError(null);
          mutation.mutate();
        }}
      >
        <Field id="provider-name" label={t("name")}>
          <input
            id="provider-name"
            value={displayName}
            onChange={(event) => {
              setDisplayName(event.target.value);
            }}
            required
            minLength={2}
            className={inputClass}
          />
        </Field>

        <Field id="provider-email" label={t("emailOptional")}>
          <input
            id="provider-email"
            type="email"
            value={email}
            onChange={(event) => {
              setEmail(event.target.value);
            }}
            className={inputClass}
          />
        </Field>

        <ErrorText>{error}</ErrorText>

        <button type="submit" disabled={mutation.isPending} className={buttonClass}>
          {t("create")}
        </button>
      </form>
    </Panel>
  );
}

/**
 * Service and location assignment.
 *
 * A checkbox list submitted as a whole set, which is exactly what the API's
 * `PUT` expects: one request, idempotent, no half-applied state if the browser
 * gives up halfway.
 */
function AssignmentsPanel({
  tenantId,
  providerId,
  onClose,
}: {
  tenantId: string;
  providerId: string;
  onClose: () => void;
}): React.ReactElement {
  const t = useTranslations("catalogue");
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  const services = useQuery({
    queryKey: ["services", tenantId],
    queryFn: () => apiFetch<Paginated<Service>>("/v1/services?limit=100", { tenantId }),
  });

  const locations = useQuery({
    queryKey: ["locations", tenantId],
    queryFn: () => apiFetch<Paginated<Location>>("/v1/locations?limit=100", { tenantId }),
  });

  const assignedServices = useQuery({
    queryKey: ["provider-services", providerId],
    queryFn: () =>
      apiFetch<{ items: AssignedService[] }>(`/v1/providers/${providerId}/services`, { tenantId }),
  });

  const assignedLocations = useQuery({
    queryKey: ["provider-locations", providerId],
    queryFn: () =>
      apiFetch<{ items: AssignedLocation[] }>(`/v1/providers/${providerId}/locations`, {
        tenantId,
      }),
  });

  const save = useMutation({
    mutationFn: async (form: HTMLFormElement) => {
      const data = new FormData(form);
      const serviceIds = data.getAll("service").map(String);
      const locationIds = data.getAll("location").map(String);

      await apiFetch(`/v1/providers/${providerId}/services`, {
        method: "PUT",
        tenantId,
        body: { services: serviceIds.map((serviceId) => ({ serviceId })) },
      });

      await apiFetch(`/v1/providers/${providerId}/locations`, {
        method: "PUT",
        tenantId,
        body: { locations: locationIds.map((locationId) => ({ locationId })) },
      });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["provider-services"] });
      void queryClient.invalidateQueries({ queryKey: ["provider-locations"] });
      onClose();
    },
    onError: (cause: unknown) => {
      setError(cause instanceof ApiError ? cause.message : t("genericError"));
    },
  });

  const assignedServiceIds = new Set(
    assignedServices.data?.items.filter((item) => item.active).map((item) => item.serviceId),
  );
  const assignedLocationIds = new Set(
    assignedLocations.data?.items.filter((item) => item.active).map((item) => item.locationId),
  );

  return (
    <Panel title={t("assignments")}>
      <form
        className="flex flex-col gap-5"
        onSubmit={(event) => {
          event.preventDefault();
          setError(null);
          save.mutate(event.currentTarget);
        }}
      >
        <fieldset className="flex flex-col gap-2">
          <legend className="text-sm font-medium">{t("services")}</legend>
          {services.data?.items.length === 0 ? (
            <p className="text-sm text-slate-600 dark:text-slate-400">{t("noServices")}</p>
          ) : (
            services.data?.items.map((service) => (
              <label key={service.id} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  name="service"
                  value={service.id}
                  defaultChecked={assignedServiceIds.has(service.id)}
                />
                <span>
                  {service.name}
                  <span className="text-slate-500"> · {service.durationMinutes} min</span>
                </span>
              </label>
            ))
          )}
        </fieldset>

        <fieldset className="flex flex-col gap-2">
          <legend className="text-sm font-medium">{t("locations")}</legend>
          {locations.data?.items.length === 0 ? (
            <p className="text-sm text-slate-600 dark:text-slate-400">{t("noLocations")}</p>
          ) : (
            locations.data?.items.map((location) => (
              <label key={location.id} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  name="location"
                  value={location.id}
                  defaultChecked={assignedLocationIds.has(location.id)}
                />
                <span>{location.name}</span>
              </label>
            ))
          )}
        </fieldset>

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
