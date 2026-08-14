"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { addDays, dateOnlyAt } from "@bam/availability-engine";
import {
  ApiError,
  apiFetch,
  type AssignedLocation,
  type AssignedService,
  type AvailabilityException,
} from "@/lib/api-client";
import { formatInZone, resolveInZone, toLocalInputValue } from "@/lib/exception-time";
import { Button } from "./ui/button";
import { Card } from "./ui/card";
import { ErrorText, Field } from "./ui/field";
import { Input, Select } from "./ui/input";
import { RowButton } from "./ui/table";

/** How far ahead the list looks by default, matching the API's own default. */
const DEFAULT_WINDOW_DAYS = 90;

interface ExceptionDraft {
  /** The row being edited, or null when creating. */
  id: string | null;
  type: string;
  startAt: string;
  endAt: string;
  locationId: string;
  serviceId: string;
  reason: string;
}

function emptyDraft(): ExceptionDraft {
  return {
    id: null,
    type: "UNAVAILABLE",
    startAt: "",
    endAt: "",
    locationId: "",
    serviceId: "",
    reason: "",
  };
}

/**
 * One-off closures and extra openings.
 *
 * Unlike the weekly schedule, these name actual moments, so every time on this
 * panel is converted through the *provider's* zone — see `@/lib/exception-time`
 * for why that conversion goes through the availability engine rather than
 * `new Date()`.
 */
export function AvailabilityExceptions({
  tenantId,
  providerId,
  timezone,
}: {
  tenantId: string;
  providerId: string;
  /** Null only while the provider record is still loading. */
  timezone: string | null;
}): React.ReactElement {
  const t = useTranslations("availability");
  const locale = useLocale();
  const queryClient = useQueryClient();

  const [draft, setDraft] = useState<ExceptionDraft>(emptyDraft());
  const [error, setError] = useState<string | null>(null);

  // The API defaults to today..+90d, which hides everything already past. Making
  // the window explicit is what lets someone go back and look.
  const today = dateOnlyAt(Date.now(), timezone ?? "UTC");
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(addDays(today, DEFAULT_WINDOW_DAYS));

  const exceptions = useQuery({
    queryKey: ["exceptions", providerId, from, to],
    queryFn: () =>
      apiFetch<{ items: AvailabilityException[] }>(
        `/v1/providers/${providerId}/availability-exceptions?from=${from}&to=${to}`,
        { tenantId },
      ),
  });

  // Scoping an exception to one location or one service is what the API has
  // always supported; the first version of this panel could only ever say
  // "everywhere, everything".
  const locations = useQuery({
    queryKey: ["provider-locations", providerId],
    queryFn: () =>
      apiFetch<{ items: AssignedLocation[] }>(`/v1/providers/${providerId}/locations`, {
        tenantId,
      }),
  });

  const services = useQuery({
    queryKey: ["provider-services", providerId],
    queryFn: () =>
      apiFetch<{ items: AssignedService[] }>(`/v1/providers/${providerId}/services`, { tenantId }),
  });

  const start = timezone === null ? null : resolveInZone(draft.startAt, timezone);
  const end = timezone === null ? null : resolveInZone(draft.endAt, timezone);

  const save = useMutation({
    mutationFn: () => {
      if (!start || !end) throw new Error("unreachable: the form requires both times");

      const body = {
        type: draft.type,
        startAt: start.instant,
        endAt: end.instant,
        locationId: draft.locationId === "" ? null : draft.locationId,
        serviceId: draft.serviceId === "" ? null : draft.serviceId,
        reason: draft.reason === "" ? null : draft.reason,
      };

      // PATCH takes the same field set, so one form serves both. Editing was
      // supported by the API from the start and simply had no UI.
      return draft.id === null
        ? apiFetch(`/v1/providers/${providerId}/availability-exceptions`, {
            method: "POST",
            tenantId,
            body,
          })
        : apiFetch(`/v1/availability-exceptions/${draft.id}`, {
            method: "PATCH",
            tenantId,
            body,
          });
    },
    onSuccess: () => {
      setDraft(emptyDraft());
      void queryClient.invalidateQueries({ queryKey: ["exceptions", providerId] });
    },
    onError: (cause: unknown) => {
      setError(cause instanceof ApiError ? cause.message : t("genericError"));
    },
  });

  return (
    <Card title={t("exceptions")}>
      <p className="text-sm text-ink-muted">
        {t("exceptionsHint")}
        {timezone === null ? "" : ` ${t("timesInZone", { zone: timezone })}`}
      </p>

      <div className="flex flex-wrap items-end gap-3">
        <Field id="exception-range-from" label={t("rangeFrom")}>
          <Input
            id="exception-range-from"
            type="date"
            value={from}
            onChange={(event) => {
              setFrom(event.target.value);
            }}
            
          />
        </Field>
        <Field id="exception-range-to" label={t("rangeTo")}>
          <Input
            id="exception-range-to"
            type="date"
            value={to}
            onChange={(event) => {
              setTo(event.target.value);
            }}
            
          />
        </Field>
      </div>

      {(exceptions.data?.items.length ?? 0) === 0 ? (
        <p className="text-sm text-ink-muted">{t("noExceptions")}</p>
      ) : (
        <ul className="flex flex-col gap-2 text-sm">
          {exceptions.data?.items.map((exception) => (
            <li key={exception.id} className="flex flex-wrap items-center gap-2">
              <span
                className={
                  exception.type === "UNAVAILABLE"
                    ? "bg-danger-surface text-on-danger-surface rounded px-2 py-0.5 text-xs"
                    : "bg-success-surface text-on-success-surface rounded px-2 py-0.5 text-xs"
                }
              >
                {t(`type.${exception.type}`)}
              </span>
              <span>
                {/* The provider's zone, not the reader's. Rendering with
                    toLocaleString() here was the mirror image of the input bug:
                    an admin abroad would enter 09:00 and be shown 08:00 back. */}
                {timezone === null
                  ? "…"
                  : `${formatInZone(exception.startAt, timezone, locale)} – ${formatInZone(
                      exception.endAt,
                      timezone,
                      locale,
                    )}`}
              </span>
              {exception.reason ? (
                <span className="text-ink-subtle">· {exception.reason}</span>
              ) : null}

              <RowButton
                onClick={() => {
                  if (timezone === null) return;

                  setError(null);
                  setDraft({
                    id: exception.id,
                    type: exception.type,
                    startAt: toLocalInputValue(exception.startAt, timezone),
                    endAt: toLocalInputValue(exception.endAt, timezone),
                    locationId: exception.locationId ?? "",
                    serviceId: exception.serviceId ?? "",
                    reason: exception.reason ?? "",
                  });
                }}
              >
                {t("edit")}
              </RowButton>

              <RowButton
                onClick={() => {
                  void apiFetch(`/v1/availability-exceptions/${exception.id}`, {
                    method: "DELETE",
                    tenantId,
                  }).then(() => {
                    void queryClient.invalidateQueries({ queryKey: ["exceptions", providerId] });
                  });
                }}
              >
                {t("remove")}
              </RowButton>
            </li>
          ))}
        </ul>
      )}

      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          setError(null);
          save.mutate();
        }}
      >
        <h3 className="text-sm font-medium">{draft.id === null ? t("add") : t("editException")}</h3>

        <div className="flex flex-wrap items-end gap-3">
          <Field id="exception-type" label={t("type.label")}>
            <Select
              id="exception-type"
              value={draft.type}
              onChange={(event) => {
                setDraft((current) => ({ ...current, type: event.target.value }));
              }}
              
            >
              <option value="UNAVAILABLE">{t("type.UNAVAILABLE")}</option>
              <option value="ADDITIONAL_AVAILABILITY">{t("type.ADDITIONAL_AVAILABILITY")}</option>
            </Select>
          </Field>

          <Field id="exception-start" label={t("from")}>
            <Input
              id="exception-start"
              type="datetime-local"
              value={draft.startAt}
              onChange={(event) => {
                setDraft((current) => ({ ...current, startAt: event.target.value }));
              }}
              required
              
            />
          </Field>

          <Field id="exception-end" label={t("to")}>
            <Input
              id="exception-end"
              type="datetime-local"
              value={draft.endAt}
              onChange={(event) => {
                setDraft((current) => ({ ...current, endAt: event.target.value }));
              }}
              required
              
            />
          </Field>
        </div>

        <div className="flex flex-wrap items-end gap-3">
          <Field id="exception-location" label={t("location")}>
            <Select
              id="exception-location"
              value={draft.locationId}
              onChange={(event) => {
                setDraft((current) => ({ ...current, locationId: event.target.value }));
              }}
              
            >
              <option value="">{t("anyLocation")}</option>
              {locations.data?.items.map((location) => (
                <option key={location.locationId} value={location.locationId}>
                  {location.locationName}
                </option>
              ))}
            </Select>
          </Field>

          <Field id="exception-service" label={t("service")}>
            <Select
              id="exception-service"
              value={draft.serviceId}
              onChange={(event) => {
                setDraft((current) => ({ ...current, serviceId: event.target.value }));
              }}
              
            >
              <option value="">{t("anyService")}</option>
              {services.data?.items.map((service) => (
                <option key={service.serviceId} value={service.serviceId}>
                  {service.serviceName}
                </option>
              ))}
            </Select>
          </Field>

          <Field id="exception-reason" label={t("reason")}>
            <Input
              id="exception-reason"
              value={draft.reason}
              onChange={(event) => {
                setDraft((current) => ({ ...current, reason: event.target.value }));
              }}
              
            />
          </Field>
        </div>

        {/* Before the request, not after. A reading the clocks jumped over is
            silently snapped by the engine, and a closure landing an hour from
            where it was typed is worth a sentence rather than a surprise. */}
        <DstNotice resolution={start?.resolution} />
        <DstNotice resolution={end?.resolution} />

        <ErrorText>{error}</ErrorText>

        <div className="flex gap-3">
          <Button type="submit" disabled={save.isPending} >
            {draft.id === null ? t("add") : t("save")}
          </Button>
          {draft.id === null ? null : (
            <Button variant="secondary"
              type="button"
              onClick={() => {
                setDraft(emptyDraft());
              }}
              
            >
              {t("cancel")}
            </Button>
          )}
        </div>
      </form>
    </Card>
  );
}

function DstNotice({ resolution }: { resolution?: string | undefined }): React.ReactElement | null {
  const t = useTranslations("availability");

  if (resolution === undefined || resolution === "exact") return null;

  return (
    <p role="status" className="text-sm text-warning">
      {resolution === "skipped" ? t("skippedWarning") : t("ambiguousWarning")}
    </p>
  );
}
