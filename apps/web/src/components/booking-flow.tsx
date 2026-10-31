"use client";

import { PageLoading } from "./ui/loading";
import { API_BASE_URL } from "@/lib/api-origin";

import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { cn } from "@/lib/cn";
import { Link } from "@/i18n/navigation";
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
import { SlotPicker, slotMonthQueryPrefix, useSlotPickerState } from "./slot-picker";
import { ServiceDescription } from "./service-description";
import { LocaleSwitcher } from "./locale-switcher";
import { ErrorText } from "./ui/form-field";
import { ThemeToggle } from "./ui/theme-toggle";
import { Brand } from "./brand";
import { ArrowRight, CalendarDays, Check, Clock3 } from "lucide-react";

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
  const queryClient = useQueryClient();

  const [step, setStep] = useState<Step>("service");
  const [serviceId, setServiceId] = useState<string | null>(null);
  const [providerId, setProviderId] = useState<string | null>(null);

  const picker = useSlotPickerState();
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

      const base = API_BASE_URL;
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
        queryKey: slotMonthQueryPrefix(tenantSlug, serviceId, providerId),
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

  if (tenant.isPending) return <PageLoading label={t("loading")} />;
  if (tenant.isError) return <p className="p-8">{t("notFound")}</p>;

  return (
    // Everything below styles itself with `booking-*`, never `brand-*`: this is
    // the one screen that belongs to the tenant rather than to us, and
    // `book/page.tsx` wraps it in the element that will one day carry their
    // colour (phase-11 §2.2).
    <main className="mx-auto flex min-h-screen max-w-[720px] flex-col gap-8 px-4 py-6 sm:px-6 sm:py-10">
      <div className="border-b border-line pb-6">
        <Brand />
      </div>
      <header className="flex flex-wrap items-start justify-between gap-6">
        <div>
          <div className="mb-4 inline-flex size-12 items-center justify-center rounded-xl bg-booking-surface text-on-booking-surface">
            <CalendarDays size={24} aria-hidden="true" />
          </div>
          <h1 className="font-display text-ink text-3xl font-bold tracking-tight sm:text-4xl">
            {tenant.data.name}
          </h1>
          <p className="mt-3 text-ink-muted text-base">{t("subtitle")}</p>
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
      {service && step !== "service" && step !== "success" ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-booking-surface px-6 py-4 text-on-booking-surface">
          <span className="font-semibold">{service.name}</span>
          <span className="flex items-center gap-2 text-sm tabular-nums">
            <Clock3 size={16} aria-hidden="true" />
            {t("minutes", { count: service.durationMinutes })}
          </span>
        </div>
      ) : null}

      {error ? <ErrorText>{error}</ErrorText> : null}

      {step === "service" ? (
        <Section title={t("chooseService")}>
          {services.data?.items.length === 0 ? <p>{t("noServices")}</p> : null}
          <ul className="flex flex-col gap-4">
            {services.data?.items.map((item) => (
              <li key={item.id} className="border-line-strong overflow-hidden rounded-xl border">
                <button
                  type="button"
                  onClick={() => {
                    setServiceId(item.id);
                    setProviderId(null);
                    setStep("provider");
                  }}
                  className="hover:bg-booking-surface w-full rounded-xl p-5 text-left transition-colors"
                >
                  <span className="flex items-center justify-between gap-4 font-semibold">
                    {item.name}
                    <ArrowRight size={18} aria-hidden="true" className="shrink-0 text-booking" />
                  </span>
                  <span className="text-ink-muted mt-2 block text-sm">
                    {t("minutes", { count: item.durationMinutes })}
                    {item.priceMinor !== null && item.currency
                      ? ` · ${formatMoney(item.priceMinor, item.currency, locale)}`
                      : ""}
                    {item.requiresApproval ? ` · ${t("needsApproval")}` : ""}
                  </span>
                </button>
                <ServiceDescription
                  description={item.description}
                  longDescriptionLabel={t("longDescription")}
                />
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
                className="border-line-strong hover:border-booking hover:bg-booking-surface min-h-16 w-full rounded-xl border p-5 text-left transition-colors"
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
                  className="border-line-strong hover:border-booking hover:bg-booking-surface min-h-16 w-full rounded-xl border p-5 text-left transition-colors"
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
          <SlotPicker
            tenantSlug={tenantSlug}
            serviceId={serviceId}
            providerId={providerId}
            state={picker}
            pending={takeHold.isPending}
            onPick={(slot) => takeHold.mutate(slot)}
          />

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
              className="text-booking font-medium underline underline-offset-2"
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

        {/* The clinic is the controller here and we are its processor, so this
            points at the part of our notice that says so rather than at the
            clinic's own notice, which we do not hold (privacy §4). */}
        <p className="text-ink-muted text-sm">
          {t.rich("privacyNote", {
            link: (chunks) => (
              <Link
                href="/privacy#patients"
                target="_blank"
                className="underline underline-offset-4"
              >
                {chunks}
              </Link>
            ),
          })}
        </p>

        <button
          type="submit"
          disabled={pending || remaining <= 0 || fullName.trim() === "" || contactMissing}
          className="bg-booking text-on-booking hover:bg-booking-hover min-h-11 w-full rounded-lg px-4 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60"
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

function Steps({ current }: { current: Step }): React.ReactElement {
  const t = useTranslations("booking");
  const order: Step[] = ["service", "provider", "time", "details", "success"];
  const index = order.indexOf(current);

  return (
    // Still an <ol> with `aria-current="step"` — the numbered circles below are
    // only the visual echo of that, exactly as the dashboard nav's underline is
    // the echo of `aria-current="page"`. The number is rendered decorative
    // because the step's name is already the list item's text.
    <div className="rounded-xl border border-line bg-surface-raised p-4">
      <ol className="grid grid-cols-5 gap-2 text-sm">
        {order.map((step, position) => {
          const done = position < index;
          const currentStep = position === index;

          return (
            <li
              key={step}
              aria-current={currentStep ? "step" : undefined}
              className="flex min-w-0 flex-col items-center gap-2 text-center"
            >
              <span
                aria-hidden="true"
                className={cn(
                  "flex size-9 shrink-0 items-center justify-center rounded-full border text-xs font-semibold",
                  done && "bg-booking border-booking text-on-booking",
                  currentStep && "border-booking text-booking border-2",
                  !done && !currentStep && "border-line-strong text-ink-subtle",
                )}
              >
                {done ? <Check size={16} /> : position + 1}
              </span>
              <span
                className={cn(
                  "sr-only sm:not-sr-only",
                  currentStep ? "text-ink font-semibold" : "text-ink-muted",
                )}
              >
                {t(`step.${step}`)}
              </span>
            </li>
          );
        })}
      </ol>
      <p aria-hidden="true" className="mt-3 text-center text-sm font-semibold sm:hidden">
        {t(`step.${current}`)}
      </p>
    </div>
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
    <section className="border-line bg-surface flex flex-col gap-6 rounded-xl border p-4 sm:p-6">
      <h2 className="font-display text-ink text-xl font-semibold">{title}</h2>
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
      className="text-booking hover:text-booking-hover inline-flex min-h-11 items-center self-start text-sm font-medium underline underline-offset-2"
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
