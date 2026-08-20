"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { cn } from "@/lib/cn";
import {
  apiFetch,
  formatMoney,
  idempotencyKey,
  withIdempotency,
  type ApiError,
  type Hold,
  type Paginated,
  type PublicBooking,
  type PublicBookingCreated,
  type Slot,
} from "@/lib/api-client";
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
import { LocaleSwitcher } from "./locale-switcher";
import { ErrorText } from "./ui/field";
import { ThemeToggle } from "./ui/theme-toggle";

/**
 * The public booking flow. tech-impl §30, §16.
 *
 * ## One page, not nine
 *
 * §28 lists `/book/service`, `/book/provider`, `/book/time` and so on as
 * separate routes. They are one route with a step state instead, because a hold
 * is live from the moment a time is picked and a real navigation between steps
 * risks losing it — a customer who taps the browser's back button between
 * `/book/time` and `/book/details` would leave a five-minute reservation behind
 * with nothing on screen able to release it. Keeping the flow in one component
 * means the hold has an owner for its whole life.
 *
 * The URL still carries the tenant, so a clinic's booking page is linkable.
 * Restoring deep links per step is Epic 6's problem, when the calendar view
 * arrives and there is something worth linking to.
 */

type Step = "service" | "provider" | "time" | "details" | "success";

interface PublicService {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  durationMinutes: number;
  priceMinor: number | null;
  currency: string | null;
  requiresApproval: boolean;
}

interface PublicProvider {
  id: string;
  displayName: string;
  description: string | null;
  languages: string[];
  timezone: string;
}

interface PublicTenant {
  id: string;
  slug: string;
  name: string;
  defaultTimezone: string;
  bookingPolicy: string | null;
  cancellationPolicy: string | null;
}

/**
 * A stable id for this browser tab.
 *
 * The API ties a hold to it so one customer cannot release another's by
 * guessing an id. `sessionStorage` rather than `localStorage`: two tabs on the
 * same booking page are two people as far as a hold is concerned, and sharing
 * the id between them would let one tab cancel the other's reservation.
 */
function useSessionId(): string {
  const [sessionId] = useState(() => {
    if (typeof window === "undefined") return "server-render-placeholder";

    const existing = window.sessionStorage.getItem("bam.sessionId");
    if (existing) return existing;

    const created = idempotencyKey();
    window.sessionStorage.setItem("bam.sessionId", created);
    return created;
  });

  return sessionId;
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
    queryKey: ["public-slots-month", args.tenantSlug, args.serviceId, args.providerId, args.month],
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

export function BookingFlow({ tenantSlug }: { tenantSlug: string }): React.ReactElement {
  const t = useTranslations("booking");
  const locale = useLocale();
  const sessionId = useSessionId();
  const queryClient = useQueryClient();

  const [step, setStep] = useState<Step>("service");
  const [serviceId, setServiceId] = useState<string | null>(null);
  const [providerId, setProviderId] = useState<string | null>(null);

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
  const [visibleMonth, setVisibleMonth] = useState<YearMonth>(() => monthOf(today));
  const [selectedDay, setSelectedDay] = useState<DateOnly | null>(null);
  const [hold, setHold] = useState<Hold | null>(null);
  const [booking, setBooking] = useState<PublicBookingCreated | null>(null);
  const [error, setError] = useState<string | null>(null);

  const tenant = useQuery({
    queryKey: ["public-tenant", tenantSlug],
    queryFn: () => apiFetch<PublicTenant>(`/v1/public/tenants/${tenantSlug}`),
  });

  const services = useQuery({
    queryKey: ["public-services", tenantSlug, locale],
    queryFn: () =>
      apiFetch<Paginated<PublicService>>(
        `/v1/public/tenants/${tenantSlug}/services?locale=${locale}&limit=50`,
      ),
  });

  const providers = useQuery({
    queryKey: ["public-providers", tenantSlug, serviceId],
    queryFn: () =>
      apiFetch<Paginated<PublicProvider>>(
        `/v1/public/tenants/${tenantSlug}/providers?serviceId=${serviceId ?? ""}&limit=50`,
      ),
    enabled: serviceId !== null,
  });

  /**
   * Approval happens in a different browser, so invalidating this tab's cache
   * from the staff mutation is impossible. The management token returned once
   * at creation is also the customer's read credential; poll with it only
   * while an approval is outstanding, then stop as soon as the booking settles.
   */
  const refreshedBooking = useQuery({
    queryKey: ["public-booking", booking?.managementToken],
    queryFn: () =>
      apiFetch<PublicBooking>(
        `/v1/public/bookings/${encodeURIComponent(booking!.managementToken)}`,
        { cache: "no-store" },
      ),
    enabled: step === "success" && booking?.status === "PENDING",
    retry: false,
    refetchInterval: (query) =>
      query.state.data === undefined || query.state.data.status === "PENDING" ? 5_000 : false,
  });

  const currentBooking =
    booking === null || refreshedBooking.data === undefined
      ? booking
      : { ...booking, ...refreshedBooking.data };

  const service = services.data?.items.find((item) => item.id === serviceId) ?? null;

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
    enabled: step === "time",
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
    enabled: step === "time" && visibleIsEmpty,
  });

  const monthAfter = useMonthSlots({
    tenantSlug,
    serviceId,
    providerId,
    month: addMonths(visibleMonth, 2),
    today,
    enabled:
      step === "time" && visibleIsEmpty && nextMonth.isSuccess && nextMonth.summaries.size === 0,
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
  }, [selectedDay, visible.isSuccess, visible.summaries, visibleMonth, today]);

  /**
   * Release the hold when the customer leaves.
   *
   * `keepalive` rather than a plain fetch: a request issued during `pagehide`
   * is cancelled when the document goes away, which is precisely the case this
   * needs to survive. It is best-effort either way — the hold expires on its
   * own in five minutes, and that expiry is the real guarantee (Epic 4 part 1).
   */
  const holdRef = useRef<Hold | null>(null);
  holdRef.current = hold;

  useEffect(() => {
    function release(): void {
      const current = holdRef.current;
      if (!current) return;

      const base = process.env["NEXT_PUBLIC_API_BASE_URL"] ?? "http://localhost:3001";
      void fetch(
        `${base}/v1/public/tenants/${tenantSlug}/holds/${current.id}?sessionId=${encodeURIComponent(sessionId)}`,
        { method: "DELETE", credentials: "include", keepalive: true },
      ).catch(() => {
        // Nothing useful to do: the page is going away and the hold expires
        // by itself.
      });
    }

    window.addEventListener("pagehide", release);
    return () => {
      window.removeEventListener("pagehide", release);
    };
  }, [tenantSlug, sessionId]);

  const takeHold = useMutation({
    mutationFn: (slot: Slot) =>
      apiFetch<Hold>(`/v1/public/tenants/${tenantSlug}/holds`, {
        method: "POST",
        headers: withIdempotency(idempotencyKey()),
        body: {
          serviceId,
          providerId: slot.providerId,
          startAt: slot.startAt,
          sessionId,
        },
      }),
    onSuccess: (created) => {
      setHold(created);
      setError(null);
      setStep("details");
    },
    onError: (cause: ApiError) => {
      // SLOT_NO_LONGER_AVAILABLE is the expected outcome of two people wanting
      // one appointment, not a fault. The times are refreshed rather than the
      // customer being left staring at one that is gone.
      setError(cause.code === "SLOT_NO_LONGER_AVAILABLE" ? t("slotTaken") : cause.message);

      // The whole prefix, not the month on show: every cached month is equally
      // stale once somebody else has taken a slot. The visible one refetches
      // now, the rest when they are next looked at — and a day that has just
      // lost its last time loses its dot with it.
      void queryClient.invalidateQueries({
        queryKey: ["public-slots-month", tenantSlug, serviceId, providerId],
      });
    },
  });

  const confirm = useMutation({
    mutationFn: (customer: { fullName: string; email: string; phone: string; notes: string }) =>
      apiFetch<PublicBookingCreated>(`/v1/public/tenants/${tenantSlug}/bookings`, {
        method: "POST",
        headers: withIdempotency(idempotencyKey()),
        body: {
          holdId: hold?.id,
          customer: {
            fullName: customer.fullName,
            ...(customer.email ? { email: customer.email } : {}),
            ...(customer.phone ? { phone: customer.phone } : {}),
            preferredLanguage: locale,
          },
          ...(customer.notes ? { notes: customer.notes } : {}),
        },
      }),
    onSuccess: (created) => {
      setBooking(created);
      // The hold became a booking; forgetting it here stops the unload handler
      // trying to release a reservation the booking now owns.
      setHold(null);
      setStep("success");
    },
    onError: (cause: ApiError) => {
      setError(cause.code === "HOLD_EXPIRED" ? t("holdExpired") : cause.message);
      if (cause.code === "HOLD_EXPIRED") {
        setHold(null);
        setStep("time");
      }
    },
  });

  if (tenant.isPending) return <p className="p-8">{t("loading")}</p>;
  if (tenant.isError) return <p className="p-8">{t("notFound")}</p>;

  return (
    // Everything below styles itself with `accent-*`, never `brand-*`: this is
    // the one screen that belongs to the tenant rather than to us, and
    // `book/page.tsx` wraps it in the element that will one day carry their
    // colour (phase-11 §2.2).
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col gap-6 px-6 py-10">
      <header className="border-line flex items-start justify-between gap-4 border-b pb-5">
        <div>
          <h1 className="font-display text-ink text-2xl font-bold tracking-tight">
            {tenant.data.name}
          </h1>
          <p className="text-ink-muted text-sm">{t("subtitle")}</p>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          {/* The page opens in the tenant's language (see book/page.tsx). This is
              the only way a customer who wants another one can say so — without
              it they would have to edit the URL, which is not a thing to ask of
              somebody trying to book a haircut. Using it also records the choice,
              so the tenant's default stops being reapplied. */}
          <LocaleSwitcher label={t("language")} />
          {/* The same control the signed-in screens carry. This page renders in
              whatever the visitor's system asks for and had no way to say
              otherwise — a customer on a dark-by-default phone who wants the
              light booking page could only change it for their whole device.
              It writes the same cookie, so a choice made here survives into the
              manage-booking screen and back. */}
          <ThemeToggle />
        </div>
      </header>

      <Steps current={step} />

      {error ? <ErrorText>{error}</ErrorText> : null}

      {step === "service" ? (
        <Section title={t("chooseService")}>
          {services.data?.items.length === 0 ? <p>{t("noServices")}</p> : null}
          <ul className="flex flex-col gap-2">
            {services.data?.items.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  onClick={() => {
                    setServiceId(item.id);
                    setProviderId(null);
                    setStep("provider");
                  }}
                  className="border-line hover:border-accent hover:bg-accent-surface w-full rounded-xl border p-4 text-left transition-colors"
                >
                  <span className="font-medium">{item.name}</span>
                  <span className="text-ink-muted block text-sm">
                    {t("minutes", { count: item.durationMinutes })}
                    {item.priceMinor !== null && item.currency
                      ? ` · ${formatMoney(item.priceMinor, item.currency, locale)}`
                      : ""}
                    {item.requiresApproval ? ` · ${t("needsApproval")}` : ""}
                  </span>
                  {item.description ? (
                    <span className="mt-1 block text-sm">{item.description}</span>
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {step === "provider" ? (
        <Section title={t("chooseProvider")}>
          <ul className="flex flex-col gap-2">
            {/* "Anyone" first: it is what most customers want, and offering it
                last makes people feel they have to choose a name. */}
            <li>
              <button
                type="button"
                onClick={() => {
                  setProviderId(null);
                  setStep("time");
                }}
                className="border-line hover:border-accent hover:bg-accent-surface w-full rounded-xl border p-4 text-left transition-colors"
              >
                <span className="font-medium">{t("anyProvider")}</span>
              </button>
            </li>
            {providers.data?.items.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  onClick={() => {
                    setProviderId(item.id);
                    setStep("time");
                  }}
                  className="border-line hover:border-accent hover:bg-accent-surface w-full rounded-xl border p-4 text-left transition-colors"
                >
                  <span className="font-medium">{item.displayName}</span>
                  {item.description ? (
                    <span className="text-ink-muted block text-sm">{item.description}</span>
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
          <BackButton onClick={() => setStep("service")} label={t("back")} />
        </Section>
      ) : null}

      {step === "time" ? (
        <Section title={t("chooseTime")}>
          {/* The calendar comes first in the DOM so it is also first on a
              phone, where the two columns stack. */}
          <div className="grid gap-6 sm:grid-cols-[minmax(0,19rem)_1fr]">
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

                  {timesOnSelectedDay.length === 0 ? (
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
                          disabled={takeHold.isPending}
                          onClick={() => takeHold.mutate(slot)}
                          className="border-line-strong hover:border-accent hover:bg-accent-surface min-h-11 w-full rounded-lg border px-3 py-2 text-sm transition-colors disabled:opacity-60"
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

          <BackButton onClick={() => setStep("provider")} label={t("back")} />
        </Section>
      ) : null}

      {step === "details" && hold ? (
        <DetailsStep
          hold={hold}
          service={service}
          locale={locale}
          pending={confirm.isPending}
          onExpire={() => {
            setHold(null);
            setError(t("holdExpired"));
            setStep("time");
          }}
          onSubmit={(customer) => confirm.mutate(customer)}
        />
      ) : null}

      {step === "success" && currentBooking ? (
        <Section title={t("booked")}>
          <dl className="border-line flex flex-col gap-2 rounded-xl border p-4">
            <Row label={t("reference")} value={currentBooking.reference} />
            <Row label={t("when")} value={formatDateTime(currentBooking.startAt, locale)} />
            <Row label={t("service")} value={currentBooking.serviceName} />
            <Row label={t("provider")} value={currentBooking.providerName} />
            {currentBooking.locationName ? (
              <Row label={t("where")} value={currentBooking.locationName} />
            ) : null}
          </dl>

          {currentBooking.status === "PENDING" || currentBooking.status === "CONFIRMED" ? (
            <p role="status" className="text-sm">
              {currentBooking.status === "PENDING" ? t("awaitingApproval") : t("approvalConfirmed")}
            </p>
          ) : null}

          <p className="text-sm">
            {t("manageHint")}{" "}
            <a
              className="text-accent font-medium underline underline-offset-2"
              href={`/booking/manage/${encodeURIComponent(currentBooking.managementToken)}`}
            >
              {t("manageLink")}
            </a>
          </p>
          {/* A confirmation genuinely is on its way now
              (docs/phase-5-booking-notifications.md). The link is still worth
              saving: it is the customer's only route to changing the booking
              online, and the reminder deliberately does not repeat it (§2.2). */}
          <p className="text-ink-muted text-sm">{t("confirmationEmail")}</p>
        </Section>
      ) : null}
    </main>
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
        className="border-line-strong hover:border-accent hover:bg-accent-surface min-h-11 self-start rounded-lg border px-3 py-2 text-left text-sm transition-colors"
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

/**
 * The customer's details, with the countdown running.
 *
 * The countdown is not decoration. A hold is five minutes and the form takes
 * about one, so somebody who is interrupted needs to know their slot is going
 * rather than discovering it at the moment they press Confirm.
 */
function DetailsStep({
  hold,
  service,
  locale,
  pending,
  onExpire,
  onSubmit,
}: {
  hold: Hold;
  service: { name: string; priceMinor: number | null; currency: string | null } | null;
  locale: string;
  pending: boolean;
  onExpire: () => void;
  onSubmit: (customer: { fullName: string; email: string; phone: string; notes: string }) => void;
}): React.ReactElement {
  const t = useTranslations("booking");
  const remaining = useCountdown(hold.expiresAt, onExpire);

  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [notes, setNotes] = useState("");

  const contactMissing = email.trim() === "" && phone.trim() === "";

  return (
    <Section title={t("yourDetails")}>
      <p
        // Polite, not assertive: it updates every second, and an assertive
        // region would have a screen reader interrupt the user continuously
        // while they are trying to type their name.
        aria-live="polite"
        className="bg-warning-surface text-on-warning-surface rounded-lg px-3 py-2 text-sm font-medium"
      >
        {t("heldFor", { time: formatCountdown(remaining) })}
      </p>

      <dl className="flex flex-col gap-1 text-sm">
        <Row label={t("when")} value={formatDateTime(hold.startAt, locale)} />
        {service ? <Row label={t("service")} value={service.name} /> : null}
        {service && service.priceMinor !== null && service.currency ? (
          <Row
            label={t("price")}
            value={formatMoney(service.priceMinor, service.currency, locale)}
          />
        ) : null}
      </dl>

      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit({ fullName, email, phone, notes });
        }}
      >
        <TextField
          id="full-name"
          label={t("fullName")}
          value={fullName}
          onChange={setFullName}
          required
        />
        <TextField id="email" label={t("email")} value={email} onChange={setEmail} type="email" />
        <TextField id="phone" label={t("phone")} value={phone} onChange={setPhone} type="tel" />
        <TextField id="notes" label={t("notes")} value={notes} onChange={setNotes} />

        {/* The API refuses this too — a booking with no contact detail is one
            nobody can confirm or warn about a cancellation. Saying it here
            saves a round trip. */}
        {contactMissing ? <p className="text-ink-muted text-sm">{t("contactRequired")}</p> : null}

        <button
          type="submit"
          disabled={pending || remaining <= 0 || fullName.trim() === "" || contactMissing}
          className="bg-accent text-on-accent hover:bg-accent-hover min-h-11 w-full rounded-lg px-4 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60"
        >
          {pending ? t("confirming") : t("confirm")}
        </button>
      </form>
    </Section>
  );
}

/**
 * Seconds left on a hold, ticking once a second.
 *
 * Derived from `expiresAt` rather than counted down from a starting number, so
 * a backgrounded tab — where browsers throttle timers hard — shows the truth
 * when it comes back rather than however far its own count happened to get.
 */
function useCountdown(expiresAt: string, onExpire: () => void): number {
  const [remaining, setRemaining] = useState(() => secondsUntil(expiresAt));
  const fired = useRef(false);

  useEffect(() => {
    fired.current = false;

    const timer = setInterval(() => {
      const next = secondsUntil(expiresAt);
      setRemaining(next);

      if (next <= 0 && !fired.current) {
        fired.current = true;
        onExpire();
      }
    }, 1000);

    return () => clearInterval(timer);
  }, [expiresAt, onExpire]);

  return remaining;
}

function secondsUntil(instant: string): number {
  return Math.max(0, Math.ceil((Date.parse(instant) - Date.now()) / 1000));
}

function formatCountdown(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes)}:${String(seconds % 60).padStart(2, "0")}`;
}

export function formatDateTime(instant: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: "full", timeStyle: "short" }).format(
    new Date(instant),
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

function Steps({ current }: { current: Step }): React.ReactElement {
  const t = useTranslations("booking");
  const order: Step[] = ["service", "provider", "time", "details", "success"];
  const index = order.indexOf(current);

  return (
    // Still an <ol> with `aria-current="step"` — the numbered circles below are
    // only the visual echo of that, exactly as the dashboard nav's underline is
    // the echo of `aria-current="page"`. The number is rendered decorative
    // because the step's name is already the list item's text.
    <ol className="flex flex-wrap items-center gap-x-2 gap-y-3 text-sm">
      {order.map((step, position) => {
        const done = position < index;
        const currentStep = position === index;

        return (
          <li
            key={step}
            aria-current={currentStep ? "step" : undefined}
            className="flex items-center gap-2"
          >
            <span
              aria-hidden="true"
              className={cn(
                "flex size-7 shrink-0 items-center justify-center rounded-full border text-xs font-semibold",
                done && "bg-accent border-accent text-on-accent",
                currentStep && "border-accent text-accent border-2",
                !done && !currentStep && "border-line-strong text-ink-subtle",
              )}
            >
              {done ? "✓" : position + 1}
            </span>
            <span className={currentStep ? "text-ink font-semibold" : "text-ink-muted"}>
              {t(`step.${step}`)}
            </span>
            {position < order.length - 1 ? (
              <span aria-hidden="true" className="text-ink-subtle ml-1">
                ›
              </span>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <section className="border-line bg-surface flex flex-col gap-4 rounded-xl border p-6">
      <h2 className="font-display text-ink text-lg font-semibold">{title}</h2>
      {children}
    </section>
  );
}

function Row({ label, value }: { label: string; value: string }): React.ReactElement {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-ink-muted">{label}</dt>
      <dd className="text-ink text-right font-medium">{value}</dd>
    </div>
  );
}

function BackButton({
  onClick,
  label,
}: {
  onClick: () => void;
  label: string;
}): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      className="text-accent hover:text-accent-hover self-start text-sm font-medium underline underline-offset-2"
    >
      {label}
    </button>
  );
}

function TextField({
  id,
  label,
  value,
  onChange,
  type = "text",
  required = false,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
  required?: boolean;
}): React.ReactElement {
  return (
    <label htmlFor={id} className="flex flex-col gap-1.5 text-sm">
      <span className="text-ink font-medium">{label}</span>
      <input
        id={id}
        type={type}
        value={value}
        required={required}
        onChange={(event) => onChange(event.target.value)}
        className="border-line-strong bg-surface text-ink min-h-11 rounded-lg border px-3 py-2"
      />
    </label>
  );
}

export { Section as BookingSection, Row as BookingRow };
