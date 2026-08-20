"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { useRouter } from "@/i18n/navigation";
import { startConversation } from "@/lib/conversation-client";
import { Button } from "./ui/button";
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
  const router = useRouter();

  const [mode, setMode] = useState<"view" | "reschedule" | "cancel">("view");
  const [newStartAt, setNewStartAt] = useState("");
  const [error, setError] = useState<string | null>(null);

  const path = `/v1/public/bookings/${encodeURIComponent(token)}`;

  const booking = useQuery({
    queryKey: ["public-booking", token],
    queryFn: () => apiFetch<PublicBooking>(path),
    retry: false,
    // Approval happens in the provider's browser. Poll only while this page is
    // waiting for that cross-browser change, then stop once it is settled.
    refetchInterval: (query) =>
      query.state.data === undefined || query.state.data.status === "PENDING" ? 5_000 : false,
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
        <p className="text-ink-muted text-sm">{t("reference", { reference: data.reference })}</p>
      </header>

      {error ? (
        <p role="alert" className="text-danger text-sm">
          {error}
        </p>
      ) : null}

      <BookingSection title={t("details")}>
        <dl className="border-line flex flex-col gap-2 rounded-xl border p-4">
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
          <p className="text-ink-muted text-sm">{data.cancellationPolicy}</p>
        ) : null}
      </BookingSection>

      {settled ? (
        <p className="text-sm">{t("nothingToDo")}</p>
      ) : mode === "view" ? (
        <div className="flex flex-wrap gap-3">
          <Button
            onClick={() => {
              void startConversation({
                tenantSlug: data.tenantSlug,
                locale,
                timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
                managementToken: token,
              }).then((started) => {
                const language = locale === "hu" ? "hu" : "en";
                sessionStorage.setItem(
                  `bam.chat.${data.tenantSlug}.${language}`,
                  JSON.stringify({ id: started.conversationId, token: started.sessionToken }),
                );
                router.push(`/${data.tenantSlug}/chat`);
              });
            }}
          >
            {locale === "hu" ? "Kérdezze az asszisztenst" : "Ask the assistant"}
          </Button>
          <button
            type="button"
            onClick={() => setMode("reschedule")}
            className="border-line-strong text-ink hover:bg-surface-raised min-h-11 rounded-lg border px-4 py-2 text-sm transition-colors"
          >
            {t("reschedule")}
          </button>
          <button
            type="button"
            onClick={() => setMode("cancel")}
            className="border-line-strong text-ink hover:bg-surface-raised min-h-11 rounded-lg border px-4 py-2 text-sm transition-colors"
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
              className="border-line-strong bg-surface text-ink min-h-11 max-w-xs rounded-lg border px-3 py-2"
            />
          </label>

          <div className="flex gap-3">
            <button
              type="button"
              disabled={newStartAt === "" || reschedulePreview.isPending}
              onClick={() => reschedulePreview.mutate(new Date(newStartAt).toISOString())}
              className="border-line-strong text-ink hover:bg-surface-raised min-h-11 rounded-lg border px-4 py-2 text-sm transition-colors disabled:opacity-60"
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
                    className="bg-danger text-on-accent min-h-11 rounded-lg px-4 py-2 text-sm font-medium disabled:opacity-60"
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
    <div className="border-line flex flex-col gap-2 rounded-xl border p-4">
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
          className="bg-accent text-on-accent hover:bg-accent-hover min-h-11 self-start rounded-lg px-4 py-2 text-sm font-medium transition-colors disabled:opacity-60"
        >
          {t("confirmMove")}
        </button>
      ) : null}
    </div>
  );
}
