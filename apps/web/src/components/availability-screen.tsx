"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import {
  ApiError,
  apiFetch,
  type AvailabilityException,
  type Paginated,
  type Provider,
  type WorkingHoursRow,
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

/** ISO 8601 weekdays, Monday first — the order a European week is read in. */
const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const;

interface Period {
  startTime: string;
  endTime: string;
}

/**
 * Provider availability. tech-impl §28.
 *
 * ## Who can edit what
 *
 * An administrator picks any provider; a provider linked to a diary sees only
 * their own and no picker at all. That mirrors the API exactly — `:own` versus
 * `:all` — but it is still only an affordance. The server re-decides on every
 * request, so a provider who edits the URL gets a 403 rather than someone
 * else's schedule.
 */
export function AvailabilityScreen(): React.ReactElement {
  const t = useTranslations("availability");
  const context = useDashboardContext();
  useSignInRedirect(!context.isPending && !context.me);

  const canManageAll = context.can("availability:manage:all");
  const ownProviderId = context.me?.membership?.providerId ?? null;

  const [selected, setSelected] = useState<string | null>(null);

  const providers = useQuery({
    queryKey: ["providers", context.tenantId],
    queryFn: () =>
      apiFetch<Paginated<Provider>>("/v1/providers?limit=100", { tenantId: context.tenantId }),
    enabled: Boolean(context.tenantId) && canManageAll,
  });

  // A provider who is not an administrator edits their own diary and is never
  // offered a choice.
  const providerId = canManageAll
    ? (selected ?? providers.data?.items[0]?.id ?? null)
    : ownProviderId;

  if (context.isPending || !context.me) {
    return <p className="p-8">{t("loading")}</p>;
  }

  return (
    <DashboardShell context={context}>
      {providerId === null ? (
        <Section title={t("title")}>
          <p className="text-sm text-slate-600 dark:text-slate-400">
            {canManageAll ? t("noProviders") : t("notLinked")}
          </p>
        </Section>
      ) : (
        <>
          {canManageAll && (providers.data?.items.length ?? 0) > 0 ? (
            <Section title={t("title")}>
              <Field id="availability-provider" label={t("provider")}>
                <select
                  id="availability-provider"
                  value={providerId}
                  onChange={(event) => {
                    setSelected(event.target.value);
                  }}
                  className={`${inputClass} max-w-sm`}
                >
                  {providers.data?.items.map((provider) => (
                    <option key={provider.id} value={provider.id}>
                      {provider.displayName}
                    </option>
                  ))}
                </select>
              </Field>
            </Section>
          ) : null}

          {context.tenantId ? (
            <>
              <WorkingHoursEditor tenantId={context.tenantId} providerId={providerId} />
              <ExceptionsPanel tenantId={context.tenantId} providerId={providerId} />
            </>
          ) : null}
        </>
      )}
    </DashboardShell>
  );
}

/**
 * The week, as a grid.
 *
 * Several periods per weekday is the normal case, not an edge case: a lunch
 * break is a gap between two periods rather than a property of one. The editor
 * therefore starts from "a list per day" instead of "one row per day with an
 * optional break".
 */
function WorkingHoursEditor({
  tenantId,
  providerId,
}: {
  tenantId: string;
  providerId: string;
}): React.ReactElement {
  const t = useTranslations("availability");
  const queryClient = useQueryClient();
  const [week, setWeek] = useState<Record<number, Period[]>>({});
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const stored = useQuery({
    queryKey: ["working-hours", providerId],
    queryFn: () =>
      apiFetch<{ items: WorkingHoursRow[] }>(`/v1/providers/${providerId}/working-hours`, {
        tenantId,
      }),
  });

  // Seed the editable copy from the server once it arrives, and again whenever
  // the provider changes.
  useEffect(() => {
    if (!stored.data) return;

    const grouped: Record<number, Period[]> = {};
    for (const row of stored.data.items) {
      (grouped[row.weekday] ??= []).push({ startTime: row.startTime, endTime: row.endTime });
    }
    setWeek(grouped);
  }, [stored.data]);

  const save = useMutation({
    mutationFn: () =>
      apiFetch(`/v1/providers/${providerId}/working-hours`, {
        method: "PUT",
        tenantId,
        body: {
          workingHours: WEEKDAYS.flatMap((weekday) =>
            (week[weekday] ?? []).map((period) => ({
              weekday,
              startTime: period.startTime,
              endTime: period.endTime,
            })),
          ),
        },
      }),
    onSuccess: () => {
      setSaved(true);
      void queryClient.invalidateQueries({ queryKey: ["working-hours", providerId] });
    },
    onError: (cause: unknown) => {
      setError(cause instanceof ApiError ? cause.message : t("genericError"));
    },
  });

  function update(weekday: number, index: number, patch: Partial<Period>): void {
    setWeek((current) => {
      const periods = [...(current[weekday] ?? [])];
      const existing = periods[index];
      if (!existing) return current;

      periods[index] = { ...existing, ...patch };
      return { ...current, [weekday]: periods };
    });
  }

  return (
    <Panel title={t("workingHours")}>
      <p className="text-sm text-slate-600 dark:text-slate-400">{t("workingHoursHint")}</p>

      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          setError(null);
          setSaved(false);
          save.mutate();
        }}
      >
        {WEEKDAYS.map((weekday) => (
          <div key={weekday} className="flex flex-col gap-2">
            <div className="flex items-center gap-3">
              <span className="w-28 text-sm font-medium">{t(`weekday.${String(weekday)}`)}</span>
              <button
                type="button"
                onClick={() => {
                  setWeek((current) => ({
                    ...current,
                    [weekday]: [
                      ...(current[weekday] ?? []),
                      { startTime: "09:00", endTime: "17:00" },
                    ],
                  }));
                }}
                className="rounded-md border border-slate-300 px-2 py-1 text-xs dark:border-slate-700"
              >
                {t("addPeriod")}
              </button>
              {(week[weekday] ?? []).length === 0 ? (
                <span className="text-xs text-slate-500">{t("closed")}</span>
              ) : null}
            </div>

            {(week[weekday] ?? []).map((period, index) => (
              // Index is a fair key here: the rows are an ordered, anonymous
              // list with no identity of their own, and reordering is not a
              // thing the editor offers.
              <div
                key={`${String(weekday)}-${String(index)}`}
                className="flex items-center gap-2 pl-28"
              >
                <input
                  type="time"
                  aria-label={t("from")}
                  value={period.startTime}
                  onChange={(event) => {
                    update(weekday, index, { startTime: event.target.value });
                  }}
                  required
                  className={inputClass}
                />
                <span className="text-sm">–</span>
                <input
                  type="time"
                  aria-label={t("to")}
                  value={period.endTime}
                  onChange={(event) => {
                    update(weekday, index, { endTime: event.target.value });
                  }}
                  required
                  className={inputClass}
                />
                <button
                  type="button"
                  onClick={() => {
                    setWeek((current) => ({
                      ...current,
                      [weekday]: (current[weekday] ?? []).filter((_, at) => at !== index),
                    }));
                  }}
                  className="rounded-md border border-slate-300 px-2 py-1 text-xs dark:border-slate-700"
                >
                  {t("remove")}
                </button>
              </div>
            ))}
          </div>
        ))}

        <ErrorText>{error}</ErrorText>
        {saved ? <p className="text-sm text-teal-700 dark:text-teal-400">{t("saved")}</p> : null}

        <button type="submit" disabled={save.isPending} className={buttonClass}>
          {t("save")}
        </button>
      </form>
    </Panel>
  );
}

/** One-off closures and extra openings. */
function ExceptionsPanel({
  tenantId,
  providerId,
}: {
  tenantId: string;
  providerId: string;
}): React.ReactElement {
  const t = useTranslations("availability");
  const queryClient = useQueryClient();

  const [type, setType] = useState("UNAVAILABLE");
  const [startAt, setStartAt] = useState("");
  const [endAt, setEndAt] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  const exceptions = useQuery({
    queryKey: ["exceptions", providerId],
    queryFn: () =>
      apiFetch<{ items: AvailabilityException[] }>(
        `/v1/providers/${providerId}/availability-exceptions`,
        { tenantId },
      ),
  });

  const create = useMutation({
    mutationFn: () =>
      apiFetch(`/v1/providers/${providerId}/availability-exceptions`, {
        method: "POST",
        tenantId,
        body: {
          type,
          // `datetime-local` has no zone, so the browser's own is used. That is
          // right for staff sitting at the clinic and wrong for an
          // administrator in another country — a per-provider zone picker is
          // the fix, and it belongs with the calendar view rather than here.
          startAt: new Date(startAt).toISOString(),
          endAt: new Date(endAt).toISOString(),
          ...(reason === "" ? {} : { reason }),
        },
      }),
    onSuccess: () => {
      setStartAt("");
      setEndAt("");
      setReason("");
      void queryClient.invalidateQueries({ queryKey: ["exceptions", providerId] });
    },
    onError: (cause: unknown) => {
      setError(cause instanceof ApiError ? cause.message : t("genericError"));
    },
  });

  return (
    <Panel title={t("exceptions")}>
      <p className="text-sm text-slate-600 dark:text-slate-400">{t("exceptionsHint")}</p>

      {(exceptions.data?.items.length ?? 0) === 0 ? (
        <p className="text-sm text-slate-600 dark:text-slate-400">{t("noExceptions")}</p>
      ) : (
        <ul className="flex flex-col gap-2 text-sm">
          {exceptions.data?.items.map((exception) => (
            <li key={exception.id} className="flex flex-wrap items-center gap-2">
              <span
                className={
                  exception.type === "UNAVAILABLE"
                    ? "rounded bg-red-50 px-2 py-0.5 text-xs dark:bg-red-950/40"
                    : "rounded bg-teal-50 px-2 py-0.5 text-xs dark:bg-teal-950/40"
                }
              >
                {t(`type.${exception.type}`)}
              </span>
              <span>
                {new Date(exception.startAt).toLocaleString()} –{" "}
                {new Date(exception.endAt).toLocaleString()}
              </span>
              {exception.reason ? (
                <span className="text-slate-500">· {exception.reason}</span>
              ) : null}
              <button
                type="button"
                onClick={() => {
                  void apiFetch(`/v1/availability-exceptions/${exception.id}`, {
                    method: "DELETE",
                    tenantId,
                  }).then(() => {
                    void queryClient.invalidateQueries({ queryKey: ["exceptions", providerId] });
                  });
                }}
                className="rounded-md border border-slate-300 px-2 py-1 text-xs dark:border-slate-700"
              >
                {t("remove")}
              </button>
            </li>
          ))}
        </ul>
      )}

      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          setError(null);
          create.mutate();
        }}
      >
        <Field id="exception-type" label={t("type.label")}>
          <select
            id="exception-type"
            value={type}
            onChange={(event) => {
              setType(event.target.value);
            }}
            className={inputClass}
          >
            <option value="UNAVAILABLE">{t("type.UNAVAILABLE")}</option>
            <option value="ADDITIONAL_AVAILABILITY">{t("type.ADDITIONAL_AVAILABILITY")}</option>
          </select>
        </Field>

        <Field id="exception-start" label={t("from")}>
          <input
            id="exception-start"
            type="datetime-local"
            value={startAt}
            onChange={(event) => {
              setStartAt(event.target.value);
            }}
            required
            className={inputClass}
          />
        </Field>

        <Field id="exception-end" label={t("to")}>
          <input
            id="exception-end"
            type="datetime-local"
            value={endAt}
            onChange={(event) => {
              setEndAt(event.target.value);
            }}
            required
            className={inputClass}
          />
        </Field>

        <Field id="exception-reason" label={t("reason")}>
          <input
            id="exception-reason"
            value={reason}
            onChange={(event) => {
              setReason(event.target.value);
            }}
            className={inputClass}
          />
        </Field>

        <button type="submit" disabled={create.isPending} className={buttonClass}>
          {t("add")}
        </button>
      </form>

      <ErrorText>{error}</ErrorText>
    </Panel>
  );
}
