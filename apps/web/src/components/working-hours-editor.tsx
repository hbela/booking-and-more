"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import type { AffectedBooking } from "@bam/contracts";
import { affectedBookingsOf } from "@/lib/affected-bookings";
import {
  ApiError,
  apiFetch,
  type AssignedLocation,
  type ScheduleLastChange,
  type WorkingHoursRow,
} from "@/lib/api-client";
import { formatRelativeAge } from "@/lib/relative-time";
import { scheduleModifiedBy } from "@/lib/schedule-modified";
import {
  END_OF_DAY,
  WEEKDAYS,
  buildWorkingHoursBody,
  emptyPeriod,
  seedWorkingWeek,
  type WorkingPeriod,
  type WorkingWeek,
} from "@/lib/working-hours";
import { AffectedBookingsDialog } from "./affected-bookings-dialog";
import { useDashboardContext } from "./dashboard-shell";
import { Button } from "./ui/button";
import { Callout } from "./ui/callout";
import { Card } from "./ui/card";
import { ErrorText, Field } from "./ui/field";
import { Input, Select } from "./ui/input";

/**
 * "Last changed by Réka, 10 minutes ago."
 *
 * ## Why this line exists
 *
 * Diary delegation made a second editor the *expected* arrangement rather than a
 * rarity: a provider and their assistant hold equal write power on one diary
 * (docs/phase-3-4-diary-delegation.md §2.3), and the week is saved as a
 * whole-set replace with no version check — so whoever saves last silently
 * reverts the other, and neither of them ever finds out.
 *
 * This does not fix that; optimistic concurrency is the fix and is not built.
 * It makes the other editor **visible**, which is the difference between a
 * conflict somebody notices the same afternoon and one discovered weeks later as
 * "my Friday keeps disappearing".
 *
 * ## Why it names the person and not only the time
 *
 * "Changed 10 minutes ago" is a question only the person who did it can answer.
 * The name is what lets the reader decide whether to go and ask before saving
 * over it — and it discloses nothing new, because the Delegates panel further
 * down this same screen already lists exactly these people.
 */
function LastChange({
  change,
  selfUserId,
}: {
  change: ScheduleLastChange;
  selfUserId: string | undefined;
}): React.ReactElement {
  const t = useTranslations("availability");
  const locale = useLocale();

  // Read at render rather than held in state: the line re-renders whenever the
  // query behind it refetches, which is exactly when the answer can have moved.
  const when = formatRelativeAge(change.at, new Date(), locale);

  return (
    <p className="text-ink-subtle text-xs">
      {change.by === null
        ? t("lastChangedUnknown", { when })
        : change.by.userId === selfUserId
          ? t("lastChangedByYou", { when })
          : t("lastChangedBy", { name: change.by.name, when })}
    </p>
  );
}

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
  const locale = useLocale();
  const context = useDashboardContext();
  const queryClient = useQueryClient();
  // Null until seeded, never `{}`. An empty week is a valid set meaning "never
  // working", so it cannot also stand for "not loaded yet" — and saving during
  // the paint between a resolved query and the effect that seeds from it would
  // have wiped the whole schedule.
  const [week, setWeek] = useState<WorkingWeek | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  /** Non-null while the "save anyway?" dialog is open. */
  const [affected, setAffected] = useState<AffectedBooking[] | null>(null);
  /**
   * The version of the week this form was seeded from (§2.14).
   *
   * Held in state and set in the *same* effect as `week`, never read from
   * `stored.data` at submit time: a background refetch updates the query data
   * one render before the effect re-seeds the form, and reading it there would
   * send the new fingerprint with the old body — which is precisely the stale
   * whole-set write this exists to refuse.
   */
  const [fingerprint, setFingerprint] = useState<string | null>(null);
  /** Non-null once a save was refused because somebody else got there first. */
  const [conflict, setConflict] = useState<{ change: ScheduleLastChange | null } | null>(null);

  const stored = useQuery({
    queryKey: ["working-hours", providerId],
    queryFn: () =>
      apiFetch<{
        items: WorkingHoursRow[];
        lastChange: ScheduleLastChange | null;
        fingerprint: string;
      }>(`/v1/providers/${providerId}/working-hours`, { tenantId }),
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
    // Both, together, from one read — see the note on `fingerprint`.
    setWeek(seedWorkingWeek(stored.data.items));
    setFingerprint(stored.data.fingerprint);
  }, [stored.data]);

  const save = useMutation({
    mutationFn: (acknowledge: boolean) => {
      if (week === null || fingerprint === null) {
        throw new Error("unreachable: the form does not render until seeded");
      }

      return apiFetch(`/v1/providers/${providerId}/working-hours`, {
        method: "PUT",
        tenantId,
        // Whole-set replacement: anything this body omits is deleted, which is
        // why the builder takes the full period and not just its times. And
        // `expectedFingerprint` is what makes that safe when somebody else can
        // edit the same diary (§2.14) — the server refuses the save rather than
        // letting it revert them.
        body: {
          ...buildWorkingHoursBody(week),
          acknowledgeAffectedBookings: acknowledge,
          expectedFingerprint: fingerprint,
        },
      });
    },
    onSuccess: () => {
      setAffected(null);
      setConflict(null);
      setSaved(true);
      void queryClient.invalidateQueries({ queryKey: ["working-hours", providerId] });
      // The badge on the bookings screen is derived from this schedule, so a
      // save that strands (or un-strands) anything changes what that list says.
      void queryClient.invalidateQueries({ queryKey: ["bookings"] });
    },
    onError: (cause: unknown) => {
      // Not a failure — the server is asking. The dialog carries the list and
      // re-sends the same body acknowledged (phase-3-4 §2.4).
      const stranded = affectedBookingsOf(cause);
      if (stranded !== null) {
        setAffected(stranded);
        return;
      }

      // The other 409 on this route, and the opposite answer: a stranded
      // booking is re-sent acknowledged, while this body may never be re-sent
      // at all — it would revert somebody's work. `undefined` means "some other
      // error", so `null` still has to stop the save (§2.14).
      const movedBy = scheduleModifiedBy(cause);
      if (movedBy !== undefined) {
        setConflict({ change: movedBy });
        return;
      }

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

      {stored.data?.lastChange ? (
        <LastChange change={stored.data.lastChange} selfUserId={context.me?.user.id} />
      ) : null}

      {/* The save was refused, so nothing on screen is lost — but it is also
          not saved, and the only way forward is to look at their version first.
          `role="alert"`: it appears in response to a press, and the button that
          caused it does not otherwise change. */}
      {conflict === null ? null : (
        <Callout tone="action" role="alert">
          <span className="flex flex-col items-start gap-2">
            <span>
              {conflict.change?.by
                ? t("scheduleMovedBy", {
                    name: conflict.change.by.name,
                    when: formatRelativeAge(conflict.change.at, new Date(), locale),
                  })
                : t("scheduleMovedUnknown")}
            </span>
            <span className="text-xs">{t("scheduleMovedHint")}</span>
            <Button
              variant="secondary"
              type="button"
              onClick={() => {
                setConflict(null);
                setError(null);
                // Re-seeds the form from their version through the effect above,
                // which discards what is on screen — which is why the hint says
                // so before the press rather than after.
                void queryClient.invalidateQueries({ queryKey: ["working-hours", providerId] });
              }}
            >
              {t("scheduleMovedReload")}
            </Button>
          </span>
        </Callout>
      )}

      {week === null ? (
        <p className="text-sm text-ink-muted">{t("loading")}</p>
      ) : (
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            setError(null);
            setSaved(false);
            setConflict(null);
            // Unacknowledged: the first attempt is always the one that can be
            // refused, so the list reaches the owner before the change lands.
            save.mutate(false);
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

          <AffectedBookingsDialog
            bookings={affected}
            busy={save.isPending}
            onConfirm={() => {
              save.mutate(true);
            }}
            onCancel={() => {
              setAffected(null);
            }}
          />
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
