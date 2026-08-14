"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { ApiError, apiFetch, type Location, type Paginated } from "@/lib/api-client";
import { diffPatch } from "@/lib/catalogue-form";
import {
  LocationFields,
  locationBodyFrom,
  locationStateFrom,
  type LocationFormState,
} from "./location-fields";
import { DashboardShell, useDashboardContext, useSignInRedirect } from "./dashboard-shell";
import { type EditPanel, useEditPanel } from "@/lib/use-edit-panel";
import { Button } from "./ui/button";
import { Card } from "./ui/card";
import { ErrorText } from "./ui/field";
import { Section } from "./ui/section";
import { RowButton } from "./ui/table";

/**
 * One-line address for the list.
 *
 * Postcode and city join with a space rather than a comma â€” "1134 Budapest" is
 * one place, not two fields â€” while the street stays a separate clause. An
 * em dash when there is nothing to show, so the column never looks broken.
 */
function formatAddress(location: Location): string {
  const settlement = [location.postalCode, location.city].filter(Boolean).join(" ");
  return [location.addressLine1, settlement].filter(Boolean).join(", ") || "â€”";
}

export function LocationsScreen(): React.ReactElement {
  const t = useTranslations("catalogue");
  const context = useDashboardContext();
  useSignInRedirect(!context.isPending && !context.me);
  const queryClient = useQueryClient();

  const edit = useEditPanel("location");
  const [showArchived, setShowArchived] = useState(false);

  const canManage = context.can("location:manage");

  const locations = useQuery({
    queryKey: ["locations", context.tenantId, showArchived],
    queryFn: () =>
      apiFetch<Paginated<Location>>(
        `/v1/locations?limit=100${showArchived ? "&includeArchived=true" : ""}`,
        { tenantId: context.tenantId },
      ),
    enabled: Boolean(context.tenantId),
  });

  const editing = locations.data?.items.find((location) => location.id === edit.openId);

  // A signed-out visitor is redirected from an effect, not from render.
  if (context.isPending || !context.me) {
    return <p className="p-8">{t("loading")}</p>;
  }

  return (
    <DashboardShell context={context}>
      <Section title={t("locations")}>
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

        {locations.data?.items.length === 0 ? (
          <p className="text-sm text-ink-muted">{t("noLocations")}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-md text-left text-sm">
              <thead className="border-b border-line">
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
                {locations.data?.items.map((location) => {
                  const archived = location.archivedAt !== null;

                  return (
                    <tr
                      key={location.id}
                      className="border-b border-line"
                    >
                      <td className={`py-2 pr-4 ${archived ? "text-ink-subtle" : ""}`}>
                        {location.name}
                      </td>
                      <td className="py-2 pr-4">{t(`locationType.${location.type}`)}</td>
                      <td className="py-2 pr-4 text-ink-muted">
                        {formatAddress(location)}
                      </td>
                      <td className="py-2 pr-4">
                        {archived ? t("archived") : location.active ? t("active") : t("inactive")}
                      </td>
                      <td className="py-2">
                        {!canManage ? null : archived ? (
                          <RowButton
                            onClick={() => {
                              void apiFetch(`/v1/locations/${location.id}/restore`, {
                                method: "POST",
                                tenantId: context.tenantId,
                              }).then(() => {
                                void queryClient.invalidateQueries({ queryKey: ["locations"] });
                              });
                            }}
                          >
                            {t("restore")}
                          </RowButton>
                        ) : (
                          <div className="flex flex-wrap gap-2">
                            <RowButton
                              onClick={() => {
                                edit.toggle(location.id);
                              }}
                              {...edit.triggerProps(location.id)}
                            >
                              {t("edit")}
                            </RowButton>
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
        <EditLocationPanel
          key={editing.id}
          tenantId={context.tenantId}
          location={editing}
          panelProps={edit.panelProps}
          onClose={edit.close}
        />
      ) : null}

      {canManage && context.tenantId ? <CreateLocationPanel tenantId={context.tenantId} /> : null}
    </DashboardShell>
  );
}

function CreateLocationPanel({ tenantId }: { tenantId: string }): React.ReactElement {
  const t = useTranslations("catalogue");
  const queryClient = useQueryClient();

  const [state, setState] = useState<LocationFormState>(() => locationStateFrom());
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () =>
      apiFetch<Location>("/v1/locations", {
        method: "POST",
        tenantId,
        body: locationBodyFrom(state, "create"),
      }),
    onSuccess: () => {
      setState(locationStateFrom());
      void queryClient.invalidateQueries({ queryKey: ["locations"] });
    },
    onError: (cause: unknown) => {
      setError(cause instanceof ApiError ? cause.message : t("genericError"));
    },
  });

  return (
    <Card title={t("addLocation")}>
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          setError(null);
          mutation.mutate();
        }}
      >
        <LocationFields
          state={state}
          idPrefix="new-location"
          onChange={(patch) => {
            setState((current) => ({ ...current, ...patch }));
          }}
        />

        <ErrorText>{error}</ErrorText>

        <Button type="submit" disabled={mutation.isPending} >
          {t("create")}
        </Button>
      </form>
    </Card>
  );
}

/** Editing a location. Sends a diff — see {@link diffPatch}. */
function EditLocationPanel({
  tenantId,
  location,
  panelProps,
  onClose,
}: {
  tenantId: string;
  location: Location;
  panelProps: EditPanel["panelProps"];
  onClose: () => void;
}): React.ReactElement {
  const t = useTranslations("catalogue");
  const queryClient = useQueryClient();

  const original = locationStateFrom(location);
  const [state, setState] = useState<LocationFormState>(original);
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: () =>
      apiFetch<Location>(`/v1/locations/${location.id}`, {
        method: "PATCH",
        tenantId,
        body: diffPatch(locationBodyFrom(original, "patch"), locationBodyFrom(state, "patch")),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["locations"] });
      onClose();
    },
    onError: (cause: unknown) => {
      setError(cause instanceof ApiError ? cause.message : t("genericError"));
    },
  });

  return (
    <Card title={t("editLocation")} {...panelProps}>
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          setError(null);
          save.mutate();
        }}
      >
        <LocationFields
          state={state}
          idPrefix={`edit-location-${location.id}`}
          onChange={(patch) => {
            setState((current) => ({ ...current, ...patch }));
          }}
        />

        <ErrorText>{error}</ErrorText>

        <div className="flex gap-3">
          <Button type="submit" disabled={save.isPending} >
            {t("saveChanges")}
          </Button>
          <Button variant="secondary" type="button" onClick={onClose} >
            {t("cancel")}
          </Button>
        </div>
      </form>
    </Card>
  );
}
