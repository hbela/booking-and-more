"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { ApiError, apiFetch, type AssignedLocation, type WorkingHoursRow } from "@/lib/api-client";
import {
  END_OF_DAY,
  WEEKDAYS,
  buildWorkingHoursBody,
  emptyPeriod,
  seedWorkingWeek,
  type WorkingPeriod,
  type WorkingWeek,
} from "@/lib/working-hours";
import { Button } from "./ui/button";
import { Card } from "./ui/card";
import { ErrorText, Field } from "./ui/field";
import { Input, Select } from "./ui/input";

/**
 * The week, as a grid.
 *
 * Several periods per weekday is the normal case: a lunch break is a gap between
 * two periods rather than a property of one. The editor therefore starts from "a
 * list per day" instead of "one row per day with an optional break".
 *
 * ## These times are not converted, on purpose
 *
 * A schedule is wall-clock (CLAUDE.md rule 13, tech-impl §13.4). "Mondays
 * 09:00–17:00" must still read 09:00–17:00 on the Monday the clocks change, so
 * the provider's zone is *named* in the hint and applied to nothing. The
 * exceptions panel is the half that does convert, because an exception names an
 * actual moment.
 */
export function WorkingHoursEditor({
  tenantId,
  providerId,
  timezone,
}: {
  tenantId: string;
  providerId: string;
  timezone: string | null;
}): React.ReactElement {
  const t = useTranslations("availability");
  const queryClient = useQueryClient();
  // Null until seeded, never `{}`. An empty week is a valid set meaning "never
  // working", so it cannot also stand for "not loaded yet" — and saving during
  // the paint between a resolved query and the effect that seeds from it would
  // have wiped the whole schedule.
  const [week, setWeek] = useState<WorkingWeek | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const stored = useQuery({
    queryKey: ["working-hours", providerId],
    queryFn: () =>
      apiFetch<{ items: WorkingHoursRow[] }>(`/v1/providers/${providerId}/working-hours`, {
        tenantId,
      }),
  });

  // Where this provider actually works, rather than every location the tenant
  // has: hours at a site they do not attend are meaningless. The API only checks
  // tenant scope, so this is a narrowing the UI chooses.
  const locations = useQuery({
    queryKey: ["provider-locations", providerId],
    queryFn: () =>
      apiFetch<{ items: AssignedLocation[] }>(`/v1/providers/${providerId}/locations`, {
        tenantId,
      }),
  });

  // Seed the editable copy from the server once it arrives, and again whenever
  // the provider changes or a save invalidates the query.
  useEffect(() => {
    if (!stored.data) return;
    setWeek(seedWorkingWeek(stored.data.items));
  }, [stored.data]);

  const save = useMutation({
    mutationFn: () => {
      if (week === null) throw new Error("unreachable: the form does not render until seeded");

      return apiFetch(`/v1/providers/${providerId}/working-hours`, {
        method: "PUT",
        tenantId,
        // Whole-set replacement: anything this body omits is deleted, which is
        // why the builder takes the full period and not just its times.
        body: buildWorkingHoursBody(week),
      });
    },
    onSuccess: () => {
      setSaved(true);
      void queryClient.invalidateQueries({ queryKey: ["working-hours", providerId] });
    },
    onError: (cause: unknown) => {
      setError(cause instanceof ApiError ? cause.message : t("genericError"));
    },
  });

  function update(weekday: number, index: number, patch: Partial<WorkingPeriod>): void {
    setWeek((current) => {
      if (current === null) return current;

      const periods = [...(current[weekday] ?? [])];
      const existing = periods[index];
      if (!existing) return current;

      periods[index] = { ...existing, ...patch };
      return { ...current, [weekday]: periods };
    });
  }

  function removePeriod(weekday: number, index: number): void {
    setWeek((current) =>
      current === null
        ? current
        : { ...current, [weekday]: (current[weekday] ?? []).filter((_, at) => at !== index) },
    );
  }

  return (
    <Card title={t("workingHours")}>
      <p className="text-sm text-ink-muted">
        {t("workingHoursHint")}
        {timezone === null ? "" : ` ${t("timesInZone", { zone: timezone })}`}
      </p>

      {week === null ? (
        <p className="text-sm text-ink-muted">{t("loading")}</p>
      ) : (
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
                    setWeek((current) =>
                      current === null
                        ? current
                        : { ...current, [weekday]: [...(current[weekday] ?? []), emptyPeriod()] },
                    );
                  }}
                  className="rounded-md border border-line-strong px-2 py-1 text-xs"
                >
                  {t("addPeriod")}
                </button>
                {(week[weekday] ?? []).length === 0 ? (
                  <span className="text-xs text-ink-subtle">{t("closed")}</span>
                ) : null}
              </div>

              {(week[weekday] ?? []).map((period, index) => (
                // Index is the right key here, and `id` would be the wrong one:
                // the API replaces the week by delete-then-insert, so every save
                // mints new row ids and keying on them would remount the whole
                // grid and drop focus mid-edit.
                <PeriodRow
                  key={`${String(weekday)}-${String(index)}`}
                  period={period}
                  locations={locations.data?.items ?? []}
                  onChange={(patch) => {
                    update(weekday, index, patch);
                  }}
                  onRemove={() => {
                    removePeriod(weekday, index);
                  }}
                />
              ))}
            </div>
          ))}

          <ErrorText>{error}</ErrorText>
          {saved ? <p className="text-success text-sm font-medium">{t("saved")}</p> : null}

          <Button type="submit" disabled={save.isPending} >
            {t("save")}
          </Button>
        </form>
      )}
    </Card>
  );
}

/**
 * One period: the two times everyone edits, and the three fields almost nobody
 * does tucked behind a disclosure.
 */
function PeriodRow({
  period,
  locations,
  onChange,
  onRemove,
}: {
  period: WorkingPeriod;
  locations: AssignedLocation[];
  onChange: (patch: Partial<WorkingPeriod>) => void;
  onRemove: () => void;
}): React.ReactElement {
  const t = useTranslations("availability");

  const toMidnight = period.endTime === END_OF_DAY;
  const scoped =
    period.locationId !== null ||
    period.validFrom !== null ||
    period.validUntil !== null ||
    !period.active;

  return (
    <div className="flex flex-col gap-2 pl-28">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          type="time"
          aria-label={t("from")}
          value={period.startTime}
          onChange={(event) => {
            onChange({ startTime: event.target.value });
          }}
          required
          
        />
        <span className="text-sm">–</span>
        <Input
          type="time"
          aria-label={t("to")}
          value={toMidnight ? "" : period.endTime}
          onChange={(event) => {
            onChange({ endTime: event.target.value });
          }}
          // "24:00" is a valid end time for the API but not a value this input
          // can hold, so while the checkbox is on the input is disabled rather
          // than showing a blank that looks like a mistake.
          disabled={toMidnight}
          required={!toMidnight}
          className="disabled:opacity-50"
        />

        <label className="flex items-center gap-1 text-xs">
          <input
            type="checkbox"
            checked={toMidnight}
            onChange={(event) => {
              onChange({ endTime: event.target.checked ? END_OF_DAY : "17:00" });
            }}
          />
          <span>{t("toMidnight")}</span>
        </label>

        <button
          type="button"
          onClick={onRemove}
          className="rounded-md border border-line-strong px-2 py-1 text-xs"
        >
          {t("remove")}
        </button>
      </div>

      <details open={scoped}>
        <summary className="cursor-pointer text-xs text-ink-muted">
          {t("periodOptions")}
        </summary>

        <div className="mt-2 flex flex-wrap gap-3 border-l border-line pl-3">
          <Field id="period-location" label={t("location")}>
            <Select
              value={period.locationId ?? ""}
              onChange={(event) => {
                onChange({ locationId: event.target.value === "" ? null : event.target.value });
              }}
              
            >
              <option value="">{t("anyLocation")}</option>
              {locations.map((location) => (
                <option key={location.locationId} value={location.locationId}>
                  {location.locationName}
                </option>
              ))}
            </Select>
          </Field>

          {/* Date-only, and it stays a string all the way to the wire: the
              server reads it as midnight UTC, so a value carrying a local
              offset lands a day out everywhere east of Greenwich. */}
          <Field id="period-valid-from" label={t("validFrom")}>
            <Input
              type="date"
              value={period.validFrom ?? ""}
              onChange={(event) => {
                onChange({ validFrom: event.target.value === "" ? null : event.target.value });
              }}
              
            />
          </Field>

          <Field id="period-valid-until" label={t("validUntil")}>
            <Input
              type="date"
              value={period.validUntil ?? ""}
              onChange={(event) => {
                onChange({ validUntil: event.target.value === "" ? null : event.target.value });
              }}
              
            />
          </Field>

          <label className="flex items-center gap-2 self-end text-sm">
            <input
              type="checkbox"
              checked={period.active}
              onChange={(event) => {
                onChange({ active: event.target.checked });
              }}
            />
            <span>{t("periodActive")}</span>
          </label>
        </div>
      </details>
    </div>
  );
}
