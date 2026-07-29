"use client";

import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
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
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col gap-6 px-6 py-10">
      <header>
        <h1 className="text-2xl font-semibold">{tenant.data.name}</h1>
        <p className="text-sm text-slate-600 dark:text-slate-400">{t("subtitle")}</p>
      </header>

      <Steps current={step} />

      {error ? (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      ) : null}

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
                  className="w-full rounded-lg border border-slate-200 p-4 text-left hover:border-brand-600 dark:border-slate-800"
                >
                  <span className="font-medium">{item.name}</span>
                  <span className="block text-sm text-slate-600 dark:text-slate-400">
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
                className="w-full rounded-lg border border-slate-200 p-4 text-left hover:border-brand-600 dark:border-slate-800"
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
                  className="w-full rounded-lg border border-slate-200 p-4 text-left hover:border-brand-600 dark:border-slate-800"
                >
                  <span className="font-medium">{item.displayName}</span>
                  {item.description ? (
                    <span className="block text-sm text-slate-600 dark:text-slate-400">
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
              className="max-w-xs rounded-md border border-slate-300 bg-transparent px-3 py-2 dark:border-slate-700"
            />
          </label>

          {slots.isPending ? <p>{t("loading")}</p> : null}
          {slots.data?.items.length === 0 ? <p>{t("noSlots")}</p> : null}

          <ul className="flex flex-wrap gap-2">
            {slots.data?.items.map((slot) => (
              <li key={`${slot.providerId}-${slot.startAt}`}>
                <button
                  type="button"
                  disabled={takeHold.isPending}
                  onClick={() => takeHold.mutate(slot)}
                  className="rounded-md border border-slate-300 px-3 py-2 text-sm hover:border-brand-600 disabled:opacity-60 dark:border-slate-700"
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
          <dl className="flex flex-col gap-2 rounded-lg border border-slate-200 p-4 dark:border-slate-800">
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
              className="underline"
              href={`/booking/manage/${encodeURIComponent(booking.managementToken)}`}
            >
              {t("manageLink")}
            </a>
          </p>
          {/* No email yet: the notification worker is Epic 5. Saying so beats a
              success screen that implies a confirmation is on its way. */}
          <p className="text-sm text-slate-600 dark:text-slate-400">{t("noEmailYet")}</p>
        </Section>
      ) : null}
    </main>
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
        className="rounded-md bg-amber-50 px-3 py-2 text-sm dark:bg-amber-950/40"
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
          <p className="text-sm text-slate-600 dark:text-slate-400">{t("contactRequired")}</p>
        ) : null}

        <button
          type="submit"
          disabled={pending || remaining <= 0 || fullName.trim() === "" || contactMissing}
          className="self-start rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
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

function Steps({ current }: { current: Step }): React.ReactElement {
  const t = useTranslations("booking");
  const order: Step[] = ["service", "provider", "time", "details", "success"];
  const index = order.indexOf(current);

  return (
    <ol className="flex flex-wrap gap-2 text-sm text-slate-600 dark:text-slate-400">
      {order.map((step, position) => (
        <li key={step} aria-current={step === current ? "step" : undefined}>
          <span
            className={position <= index ? "font-medium text-slate-900 dark:text-slate-100" : ""}
          >
            {t(`step.${step}`)}
          </span>
          {position < order.length - 1 ? <span aria-hidden="true"> › </span> : null}
        </li>
      ))}
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
    <section className="flex flex-col gap-3">
      <h2 className="text-lg font-semibold">{title}</h2>
      {children}
    </section>
  );
}

function Row({ label, value }: { label: string; value: string }): React.ReactElement {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-slate-600 dark:text-slate-400">{label}</dt>
      <dd className="text-right font-medium">{value}</dd>
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
    <button type="button" onClick={onClick} className="self-start text-sm underline">
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
    <label htmlFor={id} className="flex flex-col gap-1 text-sm">
      <span className="font-medium">{label}</span>
      <input
        id={id}
        type={type}
        value={value}
        required={required}
        onChange={(event) => onChange(event.target.value)}
        className="rounded-md border border-slate-300 bg-transparent px-3 py-2 dark:border-slate-700"
      />
    </label>
  );
}

export { Section as BookingSection, Row as BookingRow };
