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
  type CancellationPreview,
  type PublicBooking,
  type ReschedulePreview,
} from "@/lib/api-client";
import { BookingRow, BookingSection, formatDateTime } from "./booking-flow";

/**
 * What a customer reaches from their confirmation link. tech-impl §16, §28.
 *
 * ## The token is the whole of the authorization
 *
 * There is no sign-in here and there is not meant to be. The token in the URL
 * is 32 random bytes; the server stores only its SHA-256 hash and looks it up
 * by unique index. So this screen never asks who the visitor is — possessing
 * the link *is* the claim, and every way it can fail returns the same 404.
 *
 * ## Prepare before confirm
 *
 * Both actions ask the server whether they are permitted *before* showing a
 * confirmation button. It costs a round trip and buys the thing that matters:
 * a customer is never asked to agree to something that is then refused. The
 * server re-checks on confirm regardless — the preview is an affordance, not a
 * decision.
 */
export function ManageBooking({ token }: { token: string }): React.ReactElement {
  const t = useTranslations("manage");
  const locale = useLocale();
  const queryClient = useQueryClient();

  const [mode, setMode] = useState<"view" | "reschedule" | "cancel">("view");
  const [newStartAt, setNewStartAt] = useState("");
  const [error, setError] = useState<string | null>(null);

  const path = `/v1/public/bookings/${encodeURIComponent(token)}`;

  const booking = useQuery({
    queryKey: ["public-booking", token],
    queryFn: () => apiFetch<PublicBooking>(path),
    retry: false,
  });

  const cancelPreview = useQuery({
    queryKey: ["cancel-preview", token],
    queryFn: () => apiFetch<CancellationPreview>(`${path}/cancel/prepare`, { method: "POST" }),
    enabled: mode === "cancel",
  });

  const reschedulePreview = useMutation({
    mutationFn: (startAt: string) =>
      apiFetch<ReschedulePreview>(`${path}/reschedule/prepare`, {
        method: "POST",
        body: { newStartAt: startAt },
      }),
  });

  const confirmReschedule = useMutation({
    mutationFn: (startAt: string) =>
      apiFetch<PublicBooking>(`${path}/reschedule/confirm`, {
        method: "POST",
        headers: withIdempotency(idempotencyKey()),
        body: { newStartAt: startAt },
      }),
    onSuccess: () => {
      setMode("view");
      setError(null);
      void queryClient.invalidateQueries({ queryKey: ["public-booking", token] });
    },
    onError: (cause: ApiError) => setError(cause.message),
  });

  const confirmCancel = useMutation({
    mutationFn: (reason: string) =>
      apiFetch<PublicBooking>(`${path}/cancel/confirm`, {
        method: "POST",
        headers: withIdempotency(idempotencyKey()),
        body: reason ? { reason } : {},
      }),
    onSuccess: () => {
      setMode("view");
      setError(null);
      void queryClient.invalidateQueries({ queryKey: ["public-booking", token] });
    },
    onError: (cause: ApiError) => setError(cause.message),
  });

  if (booking.isPending) return <p className="p-8">{t("loading")}</p>;
  if (booking.isError) return <p className="p-8">{t("notFound")}</p>;

  const data = booking.data;
  const settled = data.status === "CANCELLED" || data.status === "COMPLETED";

  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col gap-6 px-6 py-10">
      <header>
        <h1 className="text-2xl font-semibold">{t("title")}</h1>
        <p className="text-sm text-slate-600 dark:text-slate-400">
          {t("reference", { reference: data.reference })}
        </p>
      </header>

      {error ? (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      ) : null}

      <BookingSection title={t("details")}>
        <dl className="flex flex-col gap-2 rounded-lg border border-slate-200 p-4 dark:border-slate-800">
          <BookingRow label={t("statusLabel")} value={t(`statusName.${data.status}`)} />
          <BookingRow label={t("when")} value={formatDateTime(data.startAt, locale)} />
          <BookingRow label={t("service")} value={data.serviceName} />
          <BookingRow label={t("provider")} value={data.providerName} />
          {data.locationName ? <BookingRow label={t("where")} value={data.locationName} /> : null}
          {data.priceMinor !== null && data.currency ? (
            <BookingRow
              label={t("price")}
              value={formatMoney(data.priceMinor, data.currency, locale)}
            />
          ) : null}
        </dl>

        {data.cancellationPolicy ? (
          <p className="text-sm text-slate-600 dark:text-slate-400">{data.cancellationPolicy}</p>
        ) : null}
      </BookingSection>

      {settled ? (
        <p className="text-sm">{t("nothingToDo")}</p>
      ) : mode === "view" ? (
        <div className="flex gap-3">
          <button
            type="button"
            onClick={() => setMode("reschedule")}
            className="rounded-md border border-slate-300 px-4 py-2 text-sm dark:border-slate-700"
          >
            {t("reschedule")}
          </button>
          <button
            type="button"
            onClick={() => setMode("cancel")}
            className="rounded-md border border-slate-300 px-4 py-2 text-sm dark:border-slate-700"
          >
            {t("cancel")}
          </button>
        </div>
      ) : null}

      {mode === "reschedule" ? (
        <BookingSection title={t("reschedule")}>
          <label htmlFor="new-time" className="flex flex-col gap-1 text-sm">
            <span className="font-medium">{t("newTime")}</span>
            {/* Reads in the browser's zone, not the clinic's. Right for a
                customer sitting in the same city, wrong for one abroad — a zone
                picker belongs with the calendar view in Epic 6. */}
            <input
              id="new-time"
              type="datetime-local"
              value={newStartAt}
              onChange={(event) => setNewStartAt(event.target.value)}
              className="max-w-xs rounded-md border border-slate-300 bg-transparent px-3 py-2 dark:border-slate-700"
            />
          </label>

          <div className="flex gap-3">
            <button
              type="button"
              disabled={newStartAt === "" || reschedulePreview.isPending}
              onClick={() => reschedulePreview.mutate(new Date(newStartAt).toISOString())}
              className="rounded-md border border-slate-300 px-4 py-2 text-sm disabled:opacity-60 dark:border-slate-700"
            >
              {t("check")}
            </button>
            <button
              type="button"
              onClick={() => {
                setMode("view");
                reschedulePreview.reset();
              }}
              className="text-sm underline"
            >
              {t("back")}
            </button>
          </div>

          <ReschedulePreviewPanel
            preview={reschedulePreview.data}
            locale={locale}
            pending={confirmReschedule.isPending}
            onConfirm={(startAt) => confirmReschedule.mutate(startAt)}
          />
        </BookingSection>
      ) : null}

      {mode === "cancel" ? (
        <BookingSection title={t("cancel")}>
          {cancelPreview.isPending ? <p>{t("loading")}</p> : null}

          {cancelPreview.data ? (
            <div className="flex flex-col gap-3">
              <p className="text-sm">
                {cancelPreview.data.allowed
                  ? t("cancelWarning")
                  : (cancelPreview.data.message ?? t("notPossible"))}
              </p>

              <div className="flex gap-3">
                {cancelPreview.data.allowed ? (
                  <button
                    type="button"
                    disabled={confirmCancel.isPending}
                    onClick={() => confirmCancel.mutate("")}
                    className="rounded-md bg-red-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
                  >
                    {t("confirmCancel")}
                  </button>
                ) : null}
                <button type="button" onClick={() => setMode("view")} className="text-sm underline">
                  {t("keep")}
                </button>
              </div>
            </div>
          ) : null}
        </BookingSection>
      ) : null}
    </main>
  );
}

/**
 * The answer to "can this appointment move here?".
 *
 * Split out so the preview is narrowed once, at the top, rather than being
 * re-checked inside a callback where TypeScript can no longer see that it is
 * present — which is what a non-null assertion in a click handler always means.
 */
function ReschedulePreviewPanel({
  preview,
  locale,
  pending,
  onConfirm,
}: {
  preview: ReschedulePreview | undefined;
  locale: string;
  pending: boolean;
  onConfirm: (startAt: string) => void;
}): React.ReactElement | null {
  const t = useTranslations("manage");
  if (!preview) return null;

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-slate-200 p-4 dark:border-slate-800">
      <p className="text-sm">
        {preview.allowed
          ? t("moveTo", { time: formatDateTime(preview.proposed.startAt, locale) })
          : (preview.message ?? t("notPossible"))}
      </p>

      {preview.allowed ? (
        <button
          type="button"
          disabled={pending}
          onClick={() => onConfirm(preview.proposed.startAt)}
          className="self-start rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
        >
          {t("confirmMove")}
        </button>
      ) : null}
    </div>
  );
}
