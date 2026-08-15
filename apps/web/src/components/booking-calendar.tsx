"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/cn";
import {
  addMonths,
  isBefore,
  monthOf,
  nextFocusedDay,
  type CalendarKey,
  type DayCell,
  type DaySummary,
  type YearMonth,
} from "@/lib/month-availability";
import type { DateOnly } from "@bam/availability-engine";

/**
 * The month a customer picks a day from.
 *
 * Presentational and keyboard only — no queries, no mutations, no knowledge of
 * holds. It is handed the weeks to draw and a summary per day, and reports back
 * which day was chosen and which month to load next.
 *
 * ## Why this replaces the date input rather than joining it
 *
 * The step used to carry `<input type="date">` and, when a day came back empty,
 * a row of "next available" chips. Two controls for one value is what the chips'
 * own docblock argued against: the page has to keep one idea of the day being
 * shown, not two that can disagree. A native date picker also opens *its own*
 * calendar popup, so keeping both would put two calendars on screen — and it
 * can express a day but not which days have anything, which is the entire
 * question being asked here.
 *
 * The typing it gave up is covered: PageUp/PageDown move a month, Shift with
 * them moves a year.
 *
 * ## The focus contract
 *
 * Exactly one day button is tabbable at a time (a roving tabindex), so the grid
 * is one Tab stop rather than thirty-one. Arrow keys move focus *within* it,
 * and an arrow that leaves the visible month asks the parent to change month
 * rather than refusing — clamping at the edge is what makes the last week of a
 * month unreachable by keyboard.
 *
 * Focus is only moved in the effect below when a key press asked for it. Moving
 * it whenever `focusedDay` changed would grab the caret on mount and again each
 * time a month query resolved, which is exactly the behaviour that makes a
 * page unusable with a screen reader.
 */

const KEYS = new Set<string>([
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "Home",
  "End",
  "PageUp",
  "PageDown",
]);

export interface BookingCalendarProps {
  month: YearMonth;
  weeks: DayCell[][];
  summaries: ReadonlyMap<DateOnly, DaySummary>;
  today: DateOnly;
  selectedDay: DateOnly | null;
  /** The month's slots are still loading. */
  busy: boolean;
  /** False on the current month — there is nothing bookable behind us. */
  canGoBack: boolean;
  locale: string;
  onSelect: (date: DateOnly) => void;
  onMonthChange: (month: YearMonth) => void;
}

export function BookingCalendar({
  month,
  weeks,
  summaries,
  today,
  selectedDay,
  busy,
  canGoBack,
  locale,
  onSelect,
  onMonthChange,
}: BookingCalendarProps): React.ReactElement {
  const t = useTranslations("booking");

  // Where the caret sits, which is not the same as what is selected: a keyboard
  // user walks the month before committing to a day.
  const [focusedDay, setFocusedDay] = useState<DateOnly | null>(null);
  const gridRef = useRef<HTMLTableElement | null>(null);
  const wantsFocus = useRef(false);

  useEffect(() => {
    if (!wantsFocus.current || focusedDay === null) return;
    wantsFocus.current = false;

    const target = gridRef.current?.querySelector<HTMLButtonElement>(
      `[data-date="${focusedDay}"]`,
    );
    target?.focus();
  }, [focusedDay, month]);

  const inMonth = weeks.flat().filter((cell) => cell.inMonth);

  // The one tabbable day: what is selected, else today, else the 1st. Anything
  // else and Tab would land on a day in a month the customer is not looking at.
  const tabbable =
    (selectedDay !== null && monthOf(selectedDay) === month ? selectedDay : null) ??
    (focusedDay !== null && monthOf(focusedDay) === month ? focusedDay : null) ??
    (monthOf(today) === month ? today : null) ??
    inMonth[0]?.date ??
    null;

  function move(from: DateOnly, key: CalendarKey, shift: boolean): void {
    const next = nextFocusedDay(from, key, { shift });
    wantsFocus.current = true;
    setFocusedDay(next);

    // Following focus out of the month is deliberate — see the docblock.
    if (monthOf(next) !== month) onMonthChange(monthOf(next));
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          disabled={!canGoBack}
          aria-label={t("previousMonth")}
          onClick={() => {
            onMonthChange(addMonths(month, -1));
          }}
          className="border-line-strong hover:border-accent hover:bg-accent-surface flex size-11 items-center justify-center rounded-lg border transition-colors disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-line-strong disabled:hover:bg-transparent"
        >
          <span aria-hidden="true">‹</span>
        </button>

        <p className="font-display text-base font-semibold">{formatMonth(month, locale)}</p>

        <button
          type="button"
          aria-label={t("nextMonth")}
          onClick={() => {
            onMonthChange(addMonths(month, 1));
          }}
          className="border-line-strong hover:border-accent hover:bg-accent-surface flex size-11 items-center justify-center rounded-lg border transition-colors"
        >
          <span aria-hidden="true">›</span>
        </button>
      </div>

      {/* Six rows of height reserved, so a five-row month followed by a six-row
          one does not shift the times beside it under the reader's cursor. */}
      <table
        ref={gridRef}
        role="grid"
        aria-busy={busy}
        className="w-full min-h-[19rem] table-fixed border-collapse"
      >
        <caption className="sr-only">{t("calendarCaption", { month: formatMonth(month, locale) })}</caption>
        <thead>
          <tr>
            {(weeks[0] ?? []).map((cell) => (
              <th
                key={cell.date}
                scope="col"
                abbr={formatWeekday(cell.date, locale, "long")}
                className="text-ink-subtle pb-2 text-center text-xs font-medium"
              >
                {formatWeekday(cell.date, locale, "short")}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {weeks.map((week) => (
            <tr key={week[0]?.date}>
              {week.map((cell) => (
                <Day
                  key={cell.date}
                  cell={cell}
                  summary={summaries.get(cell.date)}
                  isToday={cell.date === today}
                  isPast={isBefore(cell.date, today)}
                  isSelected={cell.date === selectedDay}
                  isTabbable={cell.date === tabbable}
                  locale={locale}
                  onSelect={onSelect}
                  onMove={move}
                />
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Day({
  cell,
  summary,
  isToday,
  isPast,
  isSelected,
  isTabbable,
  locale,
  onSelect,
  onMove,
}: {
  cell: DayCell;
  summary: DaySummary | undefined;
  isToday: boolean;
  isPast: boolean;
  isSelected: boolean;
  isTabbable: boolean;
  locale: string;
  onSelect: (date: DateOnly) => void;
  onMove: (from: DateOnly, key: CalendarKey, shift: boolean) => void;
}): React.ReactElement {
  const t = useTranslations("booking");

  // Days borrowed from the neighbouring months were never searched for, so
  // painting one as "nothing free" would assert something we did not ask.
  if (!cell.inMonth) {
    return (
      <td className="p-0.5 text-center">
        <span aria-hidden="true" className="text-ink-subtle/40 block py-2 text-sm">
          {cell.dayOfMonth}
        </span>
      </td>
    );
  }

  const count = summary?.count ?? 0;
  const bookable = !isPast && count > 0;
  const date = formatDayName(cell.date, locale);

  const label = isPast
    ? t("dayPast", { date })
    : count > 0
      ? t("dayAvailable", { date, count })
      : t("dayUnavailable", { date });

  return (
    <td role="gridcell" aria-selected={isSelected} className="p-0.5 text-center">
      <button
        type="button"
        data-date={cell.date}
        // `aria-disabled`, never `disabled`: a real disabled button is skipped
        // by some screen-reader browse modes, and a reader who cannot reach the
        // empty days cannot tell why the month looks sparse.
        aria-disabled={!bookable}
        aria-current={isToday ? "date" : undefined}
        aria-label={label}
        tabIndex={isTabbable ? 0 : -1}
        onClick={() => {
          if (bookable) onSelect(cell.date);
        }}
        onKeyDown={(event) => {
          if (!KEYS.has(event.key)) return;
          event.preventDefault();
          onMove(cell.date, event.key as CalendarKey, event.shiftKey);
        }}
        className={cn(
          "relative flex min-h-11 w-full flex-col items-center justify-center rounded-lg text-sm transition-colors",
          isSelected && "bg-accent text-on-accent font-semibold",
          !isSelected && bookable && "hover:bg-accent-surface text-ink font-medium",
          !isSelected && !bookable && "text-ink-subtle cursor-not-allowed",
          isToday && !isSelected && "ring-line-strong ring-1 ring-inset",
        )}
      >
        <span aria-hidden="true">{cell.dayOfMonth}</span>
        {/* A dot, not a colour: presence or absence is a shape, so this does
            not lean on colour alone (WCAG 1.4.1). The count is in the label. */}
        <span
          aria-hidden="true"
          className={cn(
            "mt-0.5 size-1 rounded-full",
            bookable ? (isSelected ? "bg-on-accent" : "bg-accent") : "bg-transparent",
          )}
        />
      </button>
    </td>
  );
}

/**
 * Naming a calendar date, which is not the same job as naming an instant.
 *
 * Every formatter below passes `timeZone: "UTC"` against a `T00:00:00Z`
 * instant, so the date that goes in is the date that comes out. Without it the
 * value would be read in the browser's zone and land a day late east of
 * UTC+12 — "2026-08-17" printing as Tuesday 18 August in Auckland, which is
 * both wrong and invisible to anyone west of it.
 *
 * This is the opposite of what the *times* on this page do, and deliberately
 * so: a slot is an instant and must be shown in the reader's zone, while a
 * grid cell is a calendar square with no zone at all (CLAUDE.md rule 13).
 */
function dateAt(date: DateOnly): Date {
  return new Date(`${date}T00:00:00Z`);
}

/**
 * "2026. szeptember" in Hungarian, "September 2026" in English.
 *
 * Through `Intl` rather than a message key precisely because those two differ
 * in order as well as in word: a `{month} {year}` template would be wrong in
 * Hungarian and nobody reviewing the English would see it.
 */
function formatMonth(month: YearMonth, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    year: "numeric",
    month: "long",
    timeZone: "UTC",
  }).format(dateAt(`${month}-01`));
}

function formatWeekday(date: DateOnly, locale: string, weekday: "short" | "long"): string {
  return new Intl.DateTimeFormat(locale, { weekday, timeZone: "UTC" }).format(dateAt(date));
}

function formatDayName(date: DateOnly, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: "UTC",
  }).format(dateAt(date));
}
