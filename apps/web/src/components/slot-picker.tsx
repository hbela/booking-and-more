"use client";

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { apiFetch, type Slot } from "@/lib/api-client";
import {
  addMonths,
  buildMonthGrid,
  firstAvailableDay,
  localDayOf,
  LOOKAHEAD_MONTHS,
  monthOf,
  monthRangeOf,
  slotsOnDay,
  summariseSlotsByDay,
  type DaySummary,
  type YearMonth,
} from "@/lib/month-availability";
import { firstAcrossMonths, type DayWithSlots } from "@/lib/next-available";
import type { DateOnly } from "@bam/availability-engine";
import { BookingCalendar } from "./booking-calendar";

/**
 * The month calendar and its time grid, shared by the booking form and the
 * chat. docs/phase-12-chat-slot-calendar.md §2.1.
 *
 * Both used to choose times differently — the form through this calendar, the
 * chat through six cards naming a provider each — and a customer who used both
 * saw two products. One component means they cannot drift apart again.
 *
 * Each start time appears once, whoever is free at it (`slotsOnDay` →
 * `dedupeByStart`), and the slot handed to `onPick` carries the provider the
 * API listed first. The chat matches the form here on purpose: the owner chose
 * to leave provider names out (§1).
 *
 * Words come from the page's `booking` catalogue, like the form's (§2.5).
 */

/**
 * The picker's state, owned by whoever renders it.
 *
 * Not inside {@link SlotPicker}, because the form unmounts its time step when a
 * hold is taken and remounts it when the hold expires, and the customer must
 * come back to the day they were looking at (§2.1).
 */
export interface SlotPickerState {
  today: DateOnly;
  visibleMonth: YearMonth;
  setVisibleMonth: (month: YearMonth) => void;
  selectedDay: DateOnly | null;
  setSelectedDay: (day: DateOnly | null) => void;
}

/**
 * `initialDay` opens the calendar on a day somebody already asked for — the
 * chat's "október 26". Without one, the first day with anything is chosen once
 * the month arrives.
 */
export function useSlotPickerState(initialDay: DateOnly | null = null): SlotPickerState {
  /**
   * Today, in the reader's zone — and held for the tab's life rather than read
   * per render.
   *
   * This used to be `new Date().toISOString().slice(0, 10)`, which is the *UTC*
   * day: at 01:00 CEST on 16 August it answers the 15th. That was a quiet
   * off-by-one in the old date input's `min`; here it decides which cell is
   * today and which are past, so it is visible. Frozen at mount because a tab
   * left open overnight should not have its selected day silently become
   * unbookable mid-session.
   */
  const [today] = useState(() => localDayOf(new Date().toISOString()));
  const opening = initialDay !== null && initialDay >= today ? initialDay : null;
  const [visibleMonth, setVisibleMonth] = useState<YearMonth>(() => monthOf(opening ?? today));
  const [selectedDay, setSelectedDay] = useState<DateOnly | null>(opening);

  return { today, visibleMonth, setVisibleMonth, selectedDay, setSelectedDay };
}

/**
 * The query-key prefix every cached month of one search shares — what to
 * invalidate once somebody else has taken a slot.
 */
export function slotMonthQueryPrefix(
  tenantSlug: string,
  serviceId: string | null,
  providerId: string | null,
): readonly unknown[] {
  return ["public-slots-month", tenantSlug, serviceId, providerId];
}

/**
 * One month of availability, and the per-day summary derived from it.
 *
 * Three call sites share this: the month on show and the two the page falls
 * back to when that one is empty. They differ only in `month` and `enabled`, so
 * they share a key shape — which is what makes a lookahead result double as the
 * cache entry for the navigation that follows it.
 *
 * `monthRangeOf` returning null means the whole month has gone; the query is
 * disabled rather than asking the API about days nobody can book.
 */
function useMonthSlots(args: {
  tenantSlug: string;
  serviceId: string | null;
  providerId: string | null;
  month: YearMonth;
  today: DateOnly;
  enabled: boolean;
}): ReturnType<typeof useQuery<{ items: Slot[] }>> & {
  summaries: ReadonlyMap<DateOnly, DaySummary>;
} {
  const range = monthRangeOf(args.month, args.today);

  const query = useQuery({
    queryKey: [
      ...slotMonthQueryPrefix(args.tenantSlug, args.serviceId, args.providerId),
      args.month,
    ],
    queryFn: () =>
      apiFetch<{ items: Slot[] }>(`/v1/public/tenants/${args.tenantSlug}/slots/search`, {
        method: "POST",
        body: {
          serviceId: args.serviceId,
          ...(args.providerId === null ? {} : { providerId: args.providerId }),
          dateFrom: range?.dateFrom,
          dateTo: range?.dateTo,
        },
      }),
    enabled: args.enabled && args.serviceId !== null && range !== null,
    // Availability decays as other people book. A minute is short enough that
    // nobody is reading last week's grid, and long enough that flipping between
    // two months does not re-download both.
    staleTime: 60_000,
  });

  const summaries = useMemo(
    () => summariseSlotsByDay(query.data?.items ?? []),
    [query.data?.items],
  );

  return { ...query, summaries };
}

export function SlotPicker({
  tenantSlug,
  serviceId,
  providerId,
  state,
  pending,
  onPick,
}: {
  tenantSlug: string;
  serviceId: string | null;
  providerId: string | null;
  state: SlotPickerState;
  /** A pick is in flight; every time button waits for it. */
  pending: boolean;
  onPick: (slot: Slot) => void;
}): React.ReactElement {
  const t = useTranslations("booking");
  const locale = useLocale();
  const { today, visibleMonth, setVisibleMonth, selectedDay, setSelectedDay } = state;

  /**
   * One request per month on show, answering both halves of the step.
   *
   * Until the calendar arrived this searched a single day, and a comment here
   * argued against ever widening it: "the engine would do fourteen days of work
   * to answer a question about one". **That is reversed, because the question
   * changed.** The step now asks which days of a month hold anything, so a
   * month is the honest unit — and the server barely notices. `searchSlots`
   * makes `4 + 2N` round trips whatever the range; widening multiplies only the
   * rows two range-scoped queries return and an in-memory grid walk, and a
   * month past `maximumAdvanceDays` returns before the walk begins.
   *
   * Request *count* falls, which is what the 30/minute limit actually counts:
   * guess-and-check burned one search per date tried plus a lookahead per empty
   * one, against one per month viewed, cached.
   *
   * The payload is the part that grew — a busy month is a few thousand objects
   * of near-identical ISO strings — so `@fastify/compress` was added with it.
   */
  const visible = useMonthSlots({
    tenantSlug,
    serviceId,
    providerId,
    month: visibleMonth,
    today,
    enabled: true,
  });

  // `isSuccess`, not `data?.items.length === 0`: the latter is `undefined` while
  // the query is in flight and reads as falsy, which has bitten this file before.
  const visibleIsEmpty = visible.isSuccess && visible.summaries.size === 0;

  /**
   * Where to go when a month holds nothing — two further months, no more.
   *
   * Each is an ordinary month query sharing the navigation cache, rather than a
   * bespoke wide range: the payload stays bounded exactly like any other month,
   * pressing "next month" afterwards is a cache hit, and so is the jump the
   * button below performs. A tenant with nothing free for three months is one
   * to telephone, which is why the chain stops at {@link LOOKAHEAD_MONTHS}.
   */
  const nextMonth = useMonthSlots({
    tenantSlug,
    serviceId,
    providerId,
    month: addMonths(visibleMonth, 1),
    today,
    enabled: visibleIsEmpty,
  });

  const monthAfter = useMonthSlots({
    tenantSlug,
    serviceId,
    providerId,
    month: addMonths(visibleMonth, 2),
    today,
    enabled: visibleIsEmpty && nextMonth.isSuccess && nextMonth.summaries.size === 0,
  });

  const nextAvailable = firstAcrossMonths([
    nextMonth.data?.items ?? [],
    monthAfter.data?.items ?? [],
  ]);

  const lookaheadPending = visibleIsEmpty && (nextMonth.isPending || monthAfter.isFetching);
  const nothingAhead =
    visibleIsEmpty && nextMonth.isSuccess && monthAfter.isSuccess && nextAvailable === null;

  const timesOnSelectedDay =
    selectedDay === null ? [] : slotsOnDay(visible.data?.items ?? [], selectedDay);

  /**
   * Land on a day that has something, rather than on today.
   *
   * Today is very often empty — it is half over, and the notice window may have
   * closed it entirely — and opening the step on "nothing free" is the exact
   * failure this whole view exists to remove. Only ever fills a *null*
   * selection, so it cannot overrule a day the customer chose.
   */
  useEffect(() => {
    if (selectedDay !== null || !visible.isSuccess) return;

    const first = firstAvailableDay(visible.summaries, visibleMonth, today);
    if (first !== null) setSelectedDay(first);
  }, [selectedDay, setSelectedDay, visible.isSuccess, visible.summaries, visibleMonth, today]);

  return (
    // A container query, not a viewport breakpoint: the chat renders this
    // inside a narrower column than the form does (§2.6).
    <div className="@container flex flex-col gap-6">
      {/* The calendar comes first in the DOM so it is also first on a
          phone, where the two columns stack. */}
      <div className="grid gap-6 @lg:grid-cols-[minmax(0,19rem)_1fr]">
        <BookingCalendar
          month={visibleMonth}
          weeks={buildMonthGrid(visibleMonth)}
          summaries={visible.summaries}
          today={today}
          selectedDay={selectedDay}
          busy={visible.isPending}
          canGoBack={visibleMonth > monthOf(today)}
          locale={locale}
          onSelect={setSelectedDay}
          onMonthChange={setVisibleMonth}
        />

        <div className="flex flex-col gap-3">
          {selectedDay === null ? (
            <p className="text-ink-muted text-sm">
              {visible.isPending ? t("loading") : t("selectDayFirst")}
            </p>
          ) : (
            <>
              <h3 className="font-medium">
                {t("timesOn", { date: formatDay(selectedDay, locale, today) })}
              </h3>

              {timesOnSelectedDay.length === 0 && !visible.isPending ? (
                <p className="text-ink-muted text-sm">{t("noSlots")}</p>
              ) : null}

              {/* A grid rather than a wrapping flex row, so times line up in
                  columns and the eye can scan down a time of day.
                  `tabular-nums` comes from globals.css via <time>. */}
              <ul className="grid grid-cols-[repeat(auto-fill,minmax(6rem,1fr))] gap-2">
                {timesOnSelectedDay.map((slot) => (
                  <li key={slot.startAt}>
                    <button
                      type="button"
                      disabled={pending}
                      onClick={() => onPick(slot)}
                      className="border-line-strong hover:border-booking hover:bg-booking-surface min-h-11 w-full rounded-full border px-3 py-2 text-sm transition-colors disabled:opacity-60"
                    >
                      <time dateTime={slot.startAt}>{formatTime(slot.startAt, locale)}</time>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      </div>

      {/* One `role="status"` for the whole empty-month path, which replaces
          itself twice with no input from the customer — empty, then
          searching, then somewhere to go. A sighted reader watches that
          happen; without a live region nobody else is told. One region
          rather than three so the announcements queue instead of
          interrupting each other. */}
      <div role="status" className="flex flex-col gap-3">
        {visibleIsEmpty ? (
          <p>{t("noSlotsInMonth", { month: formatMonth(visibleMonth, locale) })}</p>
        ) : null}

        {lookaheadPending ? <p className="text-ink-muted">{t("findingNext")}</p> : null}

        {visibleIsEmpty && nextAvailable !== null ? (
          <NextAvailable
            day={nextAvailable}
            locale={locale}
            today={today}
            onPick={(date) => {
              setVisibleMonth(monthOf(date));
              setSelectedDay(date);
            }}
          />
        ) : null}

        {nothingAhead ? (
          <p className="text-ink-muted">{t("noSlotsAhead", { months: LOOKAHEAD_MONTHS })}</p>
        ) : null}
      </div>
    </div>
  );
}

/**
 * The way out of a month that holds nothing: one day, one tap.
 *
 * This used to be three chips beside a date input, and the calendar took two of
 * them over — a day with times is now marked on the grid, so offering the same
 * day again as a chip says nothing the customer cannot already see. What the
 * grid cannot answer is where to look when the month it is showing is empty,
 * which is the whole of what is left here.
 *
 * Picking it moves the same `visibleMonth`/`selectedDay` the grid reads, so the
 * page keeps one idea of the day being shown rather than two that can disagree.
 *
 * The count is shown because "3 times" and "18 times" are different offers —
 * one of them is worth waiting a month for. The first start time is shown for
 * the same reason: a day that only opens at 18:00 is not a match for everybody.
 */
function NextAvailable({
  day,
  locale,
  today,
  onPick,
}: {
  day: DayWithSlots;
  locale: string;
  today: DateOnly;
  onPick: (date: DateOnly) => void;
}): React.ReactElement {
  const t = useTranslations("booking");

  return (
    <div className="flex flex-col gap-2">
      <p className="font-medium">{t("nextAvailable")}</p>
      <button
        type="button"
        onClick={() => onPick(day.date)}
        className="border-line-strong hover:border-booking hover:bg-booking-surface min-h-11 self-start rounded-lg border px-3 py-2 text-left text-sm transition-colors"
      >
        <span className="block font-medium">{formatDay(day.date, locale, today)}</span>
        <span className="text-ink-muted block text-xs">
          {t("fromTime", { time: formatTime(day.firstStartAt, locale) })} ·{" "}
          {t("slotCount", { count: day.count })}
        </span>
      </button>
    </div>
  );
}

function formatTime(instant: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { timeStyle: "short" }).format(new Date(instant));
}

/**
 * "Tuesday, 18 August" — weekday included on purpose.
 *
 * A bare date makes somebody count on their fingers to work out whether the
 * suggestion is a working day for *them*.
 *
 * The year appears only when it differs from the reader's. It used to be
 * omitted outright, on the grounds that nothing offered was more than a
 * fortnight away — no longer true now that a jump can cross two months and, in
 * November and December, a year with them.
 *
 * Takes a calendar date rather than an instant, and formats it in UTC against
 * `T00:00:00Z`, so the date that goes in is the date that comes out. Reading it
 * in the browser's zone would print a day late east of UTC+12. The *times* on
 * this page do the opposite, correctly: they are instants and belong in the
 * reader's zone.
 */
function formatDay(date: DateOnly, locale: string, today: DateOnly): string {
  return new Intl.DateTimeFormat(locale, {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: "UTC",
    ...(date.slice(0, 4) === today.slice(0, 4) ? {} : { year: "numeric" }),
  }).format(new Date(`${date}T00:00:00Z`));
}

/** "2026. szeptember" / "September 2026". Same UTC reasoning as {@link formatDay}. */
function formatMonth(month: YearMonth, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    year: "numeric",
    month: "long",
    timeZone: "UTC",
  }).format(new Date(`${month}-01T00:00:00Z`));
}
