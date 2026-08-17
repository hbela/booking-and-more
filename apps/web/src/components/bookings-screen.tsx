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
import { diaryScopeFor } from "@/lib/delegation";
import { DashboardShell, useDashboardContext, useSignInRedirect } from "./dashboard-shell";
import { Button } from "./ui/button";
import { ErrorText, Field } from "./ui/field";
import { Input, Select } from "./ui/input";
import { Section } from "./ui/section";

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

  // Three-way since diary delegation: every diary, the caller's own, or the
  // ones handed to them (docs/phase-3-4-diary-delegation.md §6.2). The filter
  // renders whenever there is more than one to choose between, which no longer
  // implies `booking:read:all`.
  const scope = diaryScopeFor(context.me, "booking:read:all", "BOOKINGS");
  const canSeeEveryone = scope.everyDiary;

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
    // Fetched for a delegate too: an ASSISTANT holds `tenant:read`, and without
    // names the filter would offer opaque ids. The options are narrowed to the
    // scope below — the list supplies labels, never reach.
    enabled:
      Boolean(context.tenantId) && (canSeeEveryone || scope.providerIds.length > 0),
  });

  const providerOptions = (providers.data?.items ?? []).filter(
    (provider) => canSeeEveryone || scope.providerIds.includes(provider.id),
  );

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
            <Input
              id="bookings-from"
              type="date"
              value={from}
              onChange={(event) => setFrom(event.target.value)}
              
            />
          </Field>
          <Field id="bookings-to" label={t("to")}>
            <Input
              id="bookings-to"
              type="date"
              value={to}
              onChange={(event) => setTo(event.target.value)}
              
            />
          </Field>

          {providerOptions.length > 1 ? (
            <Field id="bookings-provider" label={t("provider")}>
              <Select
                id="bookings-provider"
                value={providerId}
                onChange={(event) => setProviderId(event.target.value)}
                
              >
                {/* Sending no providerId is already correct for a delegate: the
                    server returns the union of the diaries they hold, so "all"
                    means "all of mine" without the client having to say so. */}
                <option value="">{canSeeEveryone ? t("allProviders") : t("myProviders")}</option>
                {providerOptions.map((provider) => (
                  <option key={provider.id} value={provider.id}>
                    {provider.displayName}
                  </option>
                ))}
              </Select>
            </Field>
          ) : null}

          <Field id="bookings-status" label={t("statusLabel")}>
            <Select
              id="bookings-status"
              value={status}
              onChange={(event) => setStatus(event.target.value)}
              
            >
              <option value="">{t("anyStatus")}</option>
              {(["PENDING", "CONFIRMED", "COMPLETED", "NO_SHOW", "CANCELLED"] as const).map(
                (value) => (
                  <option key={value} value={value}>
                    {t(`statusName.${value}`)}
                  </option>
                ),
              )}
            </Select>
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
    <li className="flex flex-col gap-2 rounded-lg border border-line p-4">
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
          <p className="text-sm text-ink-muted">
            {booking.customerName} · {booking.providerName} · {booking.reference}
            {booking.priceMinor !== null && booking.currency
              ? ` · ${formatMoney(booking.priceMinor, booking.currency, locale)}`
              : ""}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {booking.outsideSchedule ? (
            <OutsideScheduleBadge reason={booking.outsideSchedule} />
          ) : null}
          <StatusBadge status={booking.status} />
        </div>
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

/**
 * "This appointment is outside the provider's schedule."
 * docs/phase-3-4-schedule-conflicts.md §2.6.
 *
 * Beside the status chip rather than replacing it: the booking is still
 * confirmed, and what has gone wrong is a disagreement between the diary and the
 * schedule, not the booking's state.
 *
 * `warning`, never `danger`. Nothing is broken and nobody has lost their
 * appointment — the provider may simply have changed their hours and meant to.
 * The chip carries its own word for the same reason every other one does: colour
 * alone fails WCAG 1.4.1 (see {@link ./ui/badge.tsx}). The `title` names which
 * of the two reasons it is, which is detail rather than the message.
 */
function OutsideScheduleBadge({
  reason,
}: {
  reason: NonNullable<Booking["outsideSchedule"]>;
}): React.ReactElement {
  const t = useTranslations("bookings");

  return (
    <span
      className="bg-warning-surface text-on-warning-surface rounded-full px-2.5 py-0.5 text-xs font-medium"
      title={
        reason === "BLOCKED_BY_EXCEPTION"
          ? t("outsideSchedule.blocked")
          : t("outsideSchedule.hours")
      }
    >
      {t("outsideSchedule.label")}
    </span>
  );
}

function StatusBadge({ status }: { status: BookingStatus }): React.ReactElement {
  const t = useTranslations("bookings");

  const tone: Record<BookingStatus, string> = {
    PENDING: "bg-warning-surface text-on-warning-surface",
    CONFIRMED: "bg-success-surface text-on-success-surface",
    COMPLETED: "bg-surface-sunken text-ink-muted",
    NO_SHOW: "bg-warning-surface text-on-warning-surface",
    CANCELLED: "bg-danger-surface text-on-danger-surface",
    EXPIRED: "bg-surface-sunken text-ink-muted",
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
 * `<Button variant="secondary">`, **not** the primary variant with overrides
 * bolted on. That is what this used to do, back when styling was shared as
 * interpolated strings, and it rendered an invisible button: the primary recipe
 * carries `bg-primary text-white`, and appending `bg-transparent text-ink` did
 * not override them — Tailwind resolves conflicting utilities by their order in
 * the generated stylesheet, not by their order in the `class` attribute. There
 * `text-white` happened to come after `text-ink` while `bg-transparent` came
 * after `bg-primary`, so the button ended up white-on-transparent: a label
 * nobody could read, above a one-click, irreversible "Complete".
 *
 * This is the bug `cn()` now makes structurally impossible — `twMerge` drops
 * the losing utility instead of leaving both to race. Asking for the variant you
 * want is still better than overriding one you do not.
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
    <Button variant="secondary"
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="font-medium disabled:opacity-60"
    >
      {label}
    </Button>
  );
}
