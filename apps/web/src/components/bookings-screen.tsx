"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import {
  apiFetch,
  formatMoney,
  idempotencyKey,
  withIdempotency,
  type ApiError,
  type Booking,
  type BookingStatus,
  type Paginated,
  type Provider,
} from "@/lib/api-client";
import {
  DashboardShell,
  ErrorText,
  Field,
  Section,
  inputClass,
  secondaryButtonClass,
  useDashboardContext,
  useSignInRedirect,
} from "./dashboard-shell";

/**
 * The staff diary. tech-impl §17, §28.
 *
 * A list rather than a calendar grid: Epic 6 brings the visual calendar, and
 * building half of one here would mean throwing it away. What this has to do
 * first is the operational work — find today's bookings, mark who turned up,
 * cancel what needs cancelling.
 *
 * ## What the screen hides and what the server refuses
 *
 * A provider sees only their own diary because the API narrows the list for a
 * caller holding `booking:read:own`. The screen does not implement that rule;
 * it just does not offer a provider filter to somebody who cannot use one. The
 * server decides on every request, so editing the query string changes nothing.
 */
export function BookingsScreen(): React.ReactElement {
  const t = useTranslations("bookings");
  const locale = useLocale();
  const context = useDashboardContext();
  useSignInRedirect(!context.isPending && !context.me);

  const canSeeEveryone = context.can("booking:read:all");

  const [providerId, setProviderId] = useState<string>("");
  const [status, setStatus] = useState<string>("");
  const [from, setFrom] = useState(() => new Date().toISOString().slice(0, 10));
  const [to, setTo] = useState(() => {
    const later = new Date();
    later.setDate(later.getDate() + 30);
    return later.toISOString().slice(0, 10);
  });

  const providers = useQuery({
    queryKey: ["providers", context.tenantId],
    queryFn: () =>
      apiFetch<Paginated<Provider>>("/v1/providers?limit=100", { tenantId: context.tenantId }),
    enabled: Boolean(context.tenantId) && canSeeEveryone,
  });

  const query = new URLSearchParams({ from, to, limit: "50" });
  if (providerId) query.set("providerId", providerId);
  if (status) query.set("status", status);

  const bookings = useQuery({
    queryKey: ["bookings", context.tenantId, providerId, status, from, to],
    queryFn: () =>
      apiFetch<Paginated<Booking>>(`/v1/bookings?${query.toString()}`, {
        tenantId: context.tenantId,
      }),
    enabled: Boolean(context.tenantId),
  });

  if (context.isPending || !context.me) {
    return <p className="p-8">{t("loading")}</p>;
  }

  return (
    <DashboardShell context={context}>
      <Section title={t("title")}>
        <div className="flex flex-wrap gap-3">
          <Field id="bookings-from" label={t("from")}>
            <input
              id="bookings-from"
              type="date"
              value={from}
              onChange={(event) => setFrom(event.target.value)}
              className={inputClass}
            />
          </Field>
          <Field id="bookings-to" label={t("to")}>
            <input
              id="bookings-to"
              type="date"
              value={to}
              onChange={(event) => setTo(event.target.value)}
              className={inputClass}
            />
          </Field>

          {canSeeEveryone ? (
            <Field id="bookings-provider" label={t("provider")}>
              <select
                id="bookings-provider"
                value={providerId}
                onChange={(event) => setProviderId(event.target.value)}
                className={inputClass}
              >
                <option value="">{t("allProviders")}</option>
                {providers.data?.items.map((provider) => (
                  <option key={provider.id} value={provider.id}>
                    {provider.displayName}
                  </option>
                ))}
              </select>
            </Field>
          ) : null}

          <Field id="bookings-status" label={t("statusLabel")}>
            <select
              id="bookings-status"
              value={status}
              onChange={(event) => setStatus(event.target.value)}
              className={inputClass}
            >
              <option value="">{t("anyStatus")}</option>
              {(["PENDING", "CONFIRMED", "COMPLETED", "NO_SHOW", "CANCELLED"] as const).map(
                (value) => (
                  <option key={value} value={value}>
                    {t(`statusName.${value}`)}
                  </option>
                ),
              )}
            </select>
          </Field>
        </div>

        {bookings.isPending ? <p>{t("loading")}</p> : null}
        {bookings.data?.items.length === 0 ? <p>{t("empty")}</p> : null}

        <ul className="flex flex-col gap-3">
          {bookings.data?.items.map((booking) => (
            <BookingCard
              key={booking.id}
              booking={booking}
              tenantId={context.tenantId}
              locale={locale}
            />
          ))}
        </ul>
      </Section>
    </DashboardShell>
  );
}

/**
 * One booking, with the actions that apply to it.
 *
 * The action set comes from the status, mirroring the engine's transition
 * table: only a PENDING booking can be accepted, only a CONFIRMED one can be
 * completed or marked a no-show, and nothing terminal offers anything. Getting
 * this wrong shows a button that always fails, so the rules are stated once,
 * here, and the server refuses anything that slips through anyway.
 */
function BookingCard({
  booking,
  tenantId,
  locale,
}: {
  booking: Booking;
  tenantId: string | undefined;
  locale: string;
}): React.ReactElement {
  const t = useTranslations("bookings");
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["bookings"] });
  };

  const setStatus = useMutation({
    mutationFn: (next: "CONFIRMED" | "COMPLETED" | "NO_SHOW") =>
      apiFetch<Booking>(`/v1/bookings/${booking.id}`, {
        method: "PATCH",
        tenantId,
        // The version the screen read. Two people working the same diary from
        // two machines is normal at a front desk, and this is what stops the
        // second write silently overwriting the first.
        body: { status: next, version: booking.version },
      }),
    onSuccess: () => {
      setError(null);
      invalidate();
    },
    onError: (cause: ApiError) => setError(cause.message),
  });

  const cancel = useMutation({
    mutationFn: () =>
      apiFetch<Booking>(`/v1/bookings/${booking.id}/cancel/confirm`, {
        method: "POST",
        tenantId,
        headers: withIdempotency(idempotencyKey()),
        body: { version: booking.version },
      }),
    onSuccess: () => {
      setError(null);
      invalidate();
    },
    onError: (cause: ApiError) => setError(cause.message),
  });

  const busy = setStatus.isPending || cancel.isPending;

  return (
    <li className="flex flex-col gap-2 rounded-lg border border-slate-200 p-4 dark:border-slate-800">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <p className="font-medium">
            <time dateTime={booking.startAt}>
              {new Intl.DateTimeFormat(locale, {
                dateStyle: "medium",
                timeStyle: "short",
              }).format(new Date(booking.startAt))}
            </time>{" "}
            · {booking.serviceName}
          </p>
          <p className="text-sm text-slate-600 dark:text-slate-400">
            {booking.customerName} · {booking.providerName} · {booking.reference}
            {booking.priceMinor !== null && booking.currency
              ? ` · ${formatMoney(booking.priceMinor, booking.currency, locale)}`
              : ""}
          </p>
        </div>
        <StatusBadge status={booking.status} />
      </div>

      {booking.notes ? <p className="text-sm">{booking.notes}</p> : null}
      <ErrorText>{error}</ErrorText>

      <div className="flex flex-wrap gap-2">
        {booking.status === "PENDING" ? (
          <ActionButton
            disabled={busy}
            onClick={() => setStatus.mutate("CONFIRMED")}
            label={t("accept")}
          />
        ) : null}

        {booking.status === "CONFIRMED" ? (
          <>
            <ActionButton
              disabled={busy}
              onClick={() => setStatus.mutate("COMPLETED")}
              label={t("complete")}
            />
            <ActionButton
              disabled={busy}
              onClick={() => setStatus.mutate("NO_SHOW")}
              label={t("noShow")}
            />
          </>
        ) : null}

        {booking.status === "PENDING" || booking.status === "CONFIRMED" ? (
          <ActionButton disabled={busy} onClick={() => cancel.mutate()} label={t("cancel")} />
        ) : null}
      </div>
    </li>
  );
}

function StatusBadge({ status }: { status: BookingStatus }): React.ReactElement {
  const t = useTranslations("bookings");

  const tone: Record<BookingStatus, string> = {
    PENDING: "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200",
    CONFIRMED: "bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200",
    COMPLETED: "bg-slate-200 text-slate-800 dark:bg-slate-800 dark:text-slate-200",
    NO_SHOW: "bg-orange-100 text-orange-900 dark:bg-orange-950 dark:text-orange-200",
    CANCELLED: "bg-red-100 text-red-900 dark:bg-red-950 dark:text-red-200",
    EXPIRED: "bg-slate-200 text-slate-800 dark:bg-slate-800 dark:text-slate-200",
  };

  return (
    <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${tone[status]}`}>
      {t(`statusName.${status}`)}
    </span>
  );
}

/**
 * A quiet action on a booking card.
 *
 * Built from {@link secondaryButtonClass}, **not** from `buttonClass` with
 * overrides bolted on. That is what this used to do, and it rendered an
 * invisible button: `buttonClass` carries `bg-brand-600 text-white`, and
 * appending `bg-transparent text-slate-900` does not override them — Tailwind
 * resolves conflicting utilities by their order in the generated stylesheet,
 * not by their order in the `class` attribute. There `text-white` happens to
 * come after `text-slate-900` while `bg-transparent` comes after
 * `bg-brand-600`, so the button ended up white-on-transparent: a label nobody
 * could read, above a one-click, irreversible "Complete".
 *
 * The rule this encodes: compose a variant from a base that sets no conflicting
 * property, never from one that does.
 */
function ActionButton({
  onClick,
  label,
  disabled,
}: {
  onClick: () => void;
  label: string;
  disabled: boolean;
}): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`${secondaryButtonClass} font-medium disabled:opacity-60`}
    >
      {label}
    </button>
  );
}
