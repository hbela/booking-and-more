"use client";

import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
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
  type PublicBookingCreated,
  type Slot,
} from "@/lib/api-client";
import {
  addDaysToDateOnly,
  nextAvailableDays,
  LOOKAHEAD_DAYS,
  type DayWithSlots,
} from "@/lib/next-available";
import { LocaleSwitcher } from "./locale-switcher";
import { ErrorText } from "./ui/field";

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

export function BookingFlow({ tenantSlug }: { tenantSlug: string }): React.ReactElement {
  const t = useTranslations("booking");
  const locale = useLocale();
  const sessionId = useSessionId();

  const [step, setStep] = useState<Step>("service");
  const [serviceId, setServiceId] = useState<string | null>(null);
  const [providerId, setProviderId] = useState<string | null>(null);
  const [day, setDay] = useState(() => new Date().toISOString().slice(0, 10));
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

  const service = services.data?.items.find((item) => item.id === serviceId) ?? null;

  const slots = useQuery({
    queryKey: ["public-slots", tenantSlug, serviceId, providerId, day],
    queryFn: () =>
      apiFetch<{ items: Slot[] }>(`/v1/public/tenants/${tenantSlug}/slots/search`, {
        method: "POST",
        body: {
          serviceId,
          ...(providerId === null ? {} : { providerId }),
          dateFrom: day,
          dateTo: day,
        },
      }),
    enabled: serviceId !== null && step === "time",
  });

  const dayIsEmpty = slots.data?.items.length === 0;

  /**
   * The days after the empty one, asked for only once the day itself has come
   * back with nothing.
   *
   * Deliberately a second request rather than always searching a fortnight: the
   * common case is a day that has slots, and widening every search would make
   * the engine do fourteen days of work to answer a question about one. The
   * public search is rate-limited to 30/minute, and this adds at most one
   * request per date the customer tries.
   */
  const lookahead = useQuery({
    queryKey: ["public-slots-lookahead", tenantSlug, serviceId, providerId, day],
    queryFn: () =>
      apiFetch<{ items: Slot[] }>(`/v1/public/tenants/${tenantSlug}/slots/search`, {
        method: "POST",
        body: {
          serviceId,
          ...(providerId === null ? {} : { providerId }),
          // From the day *after* the one we already know is empty.
          dateFrom: addDaysToDateOnly(day, 1),
          dateTo: addDaysToDateOnly(day, LOOKAHEAD_DAYS),
        },
      }),
    enabled: serviceId !== null && step === "time" && dayIsEmpty === true,
  });

  const suggestions = nextAvailableDays(lookahead.data?.items ?? []);

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
      // one appointment, not a fault. The list is refreshed rather than the
      // customer being left staring at a time that is gone.
      setError(cause.code === "SLOT_NO_LONGER_AVAILABLE" ? t("slotTaken") : cause.message);
      void slots.refetch();
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
        {/* The page opens in the tenant's language (see book/page.tsx). This is
            the only way a customer who wants another one can say so — without
            it they would have to edit the URL, which is not a thing to ask of
            somebody trying to book a haircut. Using it also records the choice,
            so the tenant's default stops being reapplied. */}
        <LocaleSwitcher label={t("language")} />
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
                    <span className="text-ink-muted block text-sm">
                      {item.description}
                    </span>
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
          <label htmlFor="booking-day" className="flex flex-col gap-1 text-sm">
            <span className="font-medium">{t("day")}</span>
            <input
              id="booking-day"
              type="date"
              value={day}
              min={new Date().toISOString().slice(0, 10)}
              onChange={(event) => setDay(event.target.value)}
              className="max-w-xs rounded-md border border-line-strong bg-transparent px-3 py-2"
            />
          </label>

          {slots.isPending ? <p>{t("loading")}</p> : null}

          {/* `role="status"` because this region replaces itself twice without
              the customer doing anything — empty, then searching, then the
              suggestions. A sighted reader watches that happen; without a live
              region nobody else is told the page changed its mind. */}
          {dayIsEmpty === true ? (
            <div role="status" className="flex flex-col gap-3">
              <p>{t("noSlots")}</p>

              {lookahead.isPending ? <p className="text-ink-muted">{t("findingNext")}</p> : null}

              {suggestions.length > 0 ? (
                <NextAvailable days={suggestions} locale={locale} onPick={setDay} />
              ) : lookahead.isSuccess ? (
                <p className="text-ink-muted">{t("noSlotsNearby", { days: LOOKAHEAD_DAYS })}</p>
              ) : null}
            </div>
          ) : null}

          {/* A grid rather than a wrapping flex row, so slots line up in
              columns and the eye can scan down a time of day. `tabular-nums`
              comes from globals.css via the <time> element. */}
          <ul className="grid grid-cols-[repeat(auto-fill,minmax(6rem,1fr))] gap-2">
            {slots.data?.items.map((slot) => (
              <li key={`${slot.providerId}-${slot.startAt}`}>
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

      {step === "success" && booking ? (
        <Section title={t("booked")}>
          <dl className="border-line flex flex-col gap-2 rounded-xl border p-4">
            <Row label={t("reference")} value={booking.reference} />
            <Row label={t("when")} value={formatDateTime(booking.startAt, locale)} />
            <Row label={t("service")} value={booking.serviceName} />
            <Row label={t("provider")} value={booking.providerName} />
            {booking.locationName ? <Row label={t("where")} value={booking.locationName} /> : null}
          </dl>

          {booking.status === "PENDING" ? <p className="text-sm">{t("awaitingApproval")}</p> : null}

          <p className="text-sm">
            {t("manageHint")}{" "}
            <a
              className="text-accent font-medium underline underline-offset-2"
              href={`/booking/manage/${encodeURIComponent(booking.managementToken)}`}
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
 * The nearest days that do have times, offered as one tap each.
 *
 * Buttons rather than links or a second date picker: picking one moves the day
 * the customer is already looking at, which is the same thing the date input
 * does, so the page keeps one idea of "the day being shown" instead of two.
 *
 * The count is shown because "3 times" and "18 times" are different offers —
 * one of them is worth waiting a week for. The first start time is shown for
 * the same reason: a day that only opens at 18:00 is not a match for everybody.
 */
function NextAvailable({
  days,
  locale,
  onPick,
}: {
  days: DayWithSlots[];
  locale: string;
  onPick: (date: string) => void;
}): React.ReactElement {
  const t = useTranslations("booking");

  return (
    <div className="flex flex-col gap-2">
      <p className="font-medium">{t("nextAvailable")}</p>
      <ul className="flex flex-wrap gap-2">
        {days.map((entry) => (
          <li key={entry.date}>
            <button
              type="button"
              onClick={() => onPick(entry.date)}
              className="border-line-strong hover:border-accent hover:bg-accent-surface min-h-11 rounded-lg border px-3 py-2 text-left text-sm transition-colors"
            >
              <span className="block font-medium">{formatDay(entry.firstStartAt, locale)}</span>
              <span className="text-ink-muted block text-xs">
                {t("fromTime", { time: formatTime(entry.firstStartAt, locale) })} ·{" "}
                {t("slotCount", { count: entry.count })}
              </span>
            </button>
          </li>
        ))}
      </ul>
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
        {contactMissing ? (
          <p className="text-ink-muted text-sm">{t("contactRequired")}</p>
        ) : null}

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
 * suggestion is a working day for *them*. No year: everything offered is within
 * a fortnight.
 */
function formatDay(instant: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(new Date(instant));
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
