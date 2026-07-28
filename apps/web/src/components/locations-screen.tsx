"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import {
  ApiError,
  apiFetch,
  type Location,
  type LocationType,
  type Paginated,
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

const TYPES: LocationType[] = ["PHYSICAL", "ONLINE", "HOME_VISIT", "TELEPHONE"];

/**
 * One-line address for the list.
 *
 * Postcode and city join with a space rather than a comma — "1134 Budapest" is
 * one place, not two fields — while the street stays a separate clause. An
 * em dash when there is nothing to show, so the column never looks broken.
 */
function formatAddress(location: Location): string {
  const settlement = [location.postalCode, location.city].filter(Boolean).join(" ");
  return [location.addressLine1, settlement].filter(Boolean).join(", ") || "—";
}

export function LocationsScreen(): React.ReactElement {
  const t = useTranslations("catalogue");
  const context = useDashboardContext();
  useSignInRedirect(!context.isPending && !context.me);
  const queryClient = useQueryClient();

  const canManage = context.can("location:manage");

  const locations = useQuery({
    queryKey: ["locations", context.tenantId],
    queryFn: () =>
      apiFetch<Paginated<Location>>("/v1/locations?limit=100", { tenantId: context.tenantId }),
    enabled: Boolean(context.tenantId),
  });

  // A signed-out visitor is redirected from an effect, not from render.
  if (context.isPending || !context.me) {
    return <p className="p-8">{t("loading")}</p>;
  }

  return (
    <DashboardShell context={context}>
      <Section title={t("locations")}>
        {locations.data?.items.length === 0 ? (
          <p className="text-sm text-slate-600 dark:text-slate-400">{t("noLocations")}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-md text-left text-sm">
              <thead className="border-b border-slate-200 dark:border-slate-800">
                <tr>
                  <th scope="col" className="py-2 pr-4 font-medium">
                    {t("name")}
                  </th>
                  <th scope="col" className="py-2 pr-4 font-medium">
                    {t("type")}
                  </th>
                  <th scope="col" className="py-2 pr-4 font-medium">
                    {t("address")}
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
                {locations.data?.items.map((location) => (
                  <tr key={location.id} className="border-b border-slate-100 dark:border-slate-900">
                    <td className="py-2 pr-4">{location.name}</td>
                    <td className="py-2 pr-4">{t(`locationType.${location.type}`)}</td>
                    <td className="py-2 pr-4 text-slate-600 dark:text-slate-400">
                      {formatAddress(location)}
                    </td>
                    <td className="py-2 pr-4">{location.active ? t("active") : t("inactive")}</td>
                    <td className="py-2">
                      {canManage ? (
                        <div className="flex flex-wrap gap-2">
                          <RowButton
                            onClick={() => {
                              void apiFetch(`/v1/locations/${location.id}`, {
                                method: "PATCH",
                                tenantId: context.tenantId,
                                body: { active: !location.active },
                              }).then(() => {
                                void queryClient.invalidateQueries({ queryKey: ["locations"] });
                              });
                            }}
                          >
                            {location.active ? t("deactivate") : t("activate")}
                          </RowButton>
                          <RowButton
                            onClick={() => {
                              void apiFetch(`/v1/locations/${location.id}`, {
                                method: "DELETE",
                                tenantId: context.tenantId,
                              }).then(() => {
                                void queryClient.invalidateQueries({ queryKey: ["locations"] });
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

      {canManage && context.tenantId ? <CreateLocationPanel tenantId={context.tenantId} /> : null}
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

function CreateLocationPanel({ tenantId }: { tenantId: string }): React.ReactElement {
  const t = useTranslations("catalogue");
  const queryClient = useQueryClient();

  const [name, setName] = useState("");
  const [type, setType] = useState<LocationType>("PHYSICAL");
  const [addressLine1, setAddressLine1] = useState("");
  const [postalCode, setPostalCode] = useState("");
  const [city, setCity] = useState("");
  const [error, setError] = useState<string | null>(null);

  // The API enforces this too; the form mirrors it so the requirement is visible
  // before the request rather than after it.
  const needsAddress = type === "PHYSICAL";

  const mutation = useMutation({
    mutationFn: () =>
      apiFetch<Location>("/v1/locations", {
        method: "POST",
        tenantId,
        body: {
          name,
          type,
          ...(addressLine1 === "" ? {} : { addressLine1 }),
          ...(postalCode === "" ? {} : { postalCode }),
          ...(city === "" ? {} : { city }),
        },
      }),
    onSuccess: () => {
      setName("");
      setAddressLine1("");
      setPostalCode("");
      setCity("");
      void queryClient.invalidateQueries({ queryKey: ["locations"] });
    },
    onError: (cause: unknown) => {
      setError(cause instanceof ApiError ? cause.message : t("genericError"));
    },
  });

  return (
    <Panel title={t("addLocation")}>
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          setError(null);
          mutation.mutate();
        }}
      >
        <Field id="location-name" label={t("name")}>
          <input
            id="location-name"
            value={name}
            onChange={(event) => {
              setName(event.target.value);
            }}
            required
            minLength={2}
            className={inputClass}
          />
        </Field>

        <Field id="location-type" label={t("type")}>
          <select
            id="location-type"
            value={type}
            onChange={(event) => {
              setType(event.target.value as LocationType);
            }}
            className={inputClass}
          >
            {TYPES.map((value) => (
              <option key={value} value={value}>
                {t(`locationType.${value}`)}
              </option>
            ))}
          </select>
        </Field>

        {needsAddress ? (
          <>
            <Field id="location-address" label={t("address")}>
              <input
                id="location-address"
                value={addressLine1}
                onChange={(event) => {
                  setAddressLine1(event.target.value);
                }}
                required
                className={inputClass}
              />
            </Field>

            {/* Postcode before city: that is the order a Hungarian address is
                written and read ("1134 Budapest"), and the pilot tenant is
                Hungarian. Worth revisiting per country in Epic 9. */}
            <div className="flex flex-wrap gap-3">
              <Field id="location-postal-code" label={t("postalCode")}>
                <input
                  id="location-postal-code"
                  value={postalCode}
                  onChange={(event) => {
                    setPostalCode(event.target.value);
                  }}
                  inputMode="numeric"
                  maxLength={20}
                  className={`${inputClass} w-32`}
                />
              </Field>

              <Field id="location-city" label={t("city")}>
                <input
                  id="location-city"
                  value={city}
                  onChange={(event) => {
                    setCity(event.target.value);
                  }}
                  className={inputClass}
                />
              </Field>
            </div>
          </>
        ) : null}

        <ErrorText>{error}</ErrorText>

        <button type="submit" disabled={mutation.isPending} className={buttonClass}>
          {t("create")}
        </button>
      </form>
    </Panel>
  );
}
