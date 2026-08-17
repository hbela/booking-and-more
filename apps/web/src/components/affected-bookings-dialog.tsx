"use client";

import { useEffect, useRef } from "react";
import { useLocale, useTranslations } from "next-intl";
import type { AffectedBooking } from "@bam/contracts";
import { Button } from "./ui/button";

/**
 * "This leaves these appointments outside your schedule. Save anyway?"
 * docs/phase-3-4-schedule-conflicts.md §2.4.
 *
 * Shown when a schedule save comes back `SCHEDULE_CONFLICTS_BOOKINGS`. The
 * decision is genuinely the clinic's — availability belongs to the provider
 * (phase-2-3 §2.6) — so this informs and gets out of the way rather than
 * blocking. Confirming re-sends the identical request with the acknowledgement,
 * and the server checks again.
 *
 * ## A native `<dialog>`, not a div with a high z-index
 *
 * `showModal()` gives the focus trap, the Escape key, the inert background and
 * the `aria-modal` semantics for free — all four of which a hand-rolled overlay
 * has to re-earn, and typically earns three of. Same reasoning as the plain
 * `<select>` in {@link ./locale-switcher.tsx}.
 *
 * The times are printed in the *reader's* zone, deliberately unlike the working
 * hours grid above it, which is wall-clock and zoneless (rule 13). An
 * appointment is an instant; a schedule is a rule. This is the same two-zones-
 * on-one-screen situation phase-6 §2.7 records, and the answer is the same: each
 * is shown in the zone that makes it true.
 */
export function AffectedBookingsDialog({
  bookings,
  busy,
  onConfirm,
  onCancel,
}: {
  /** Null closes it. A dialog with nothing to list must not be open. */
  bookings: AffectedBooking[] | null;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}): React.ReactElement | null {
  const t = useTranslations("availability");
  const locale = useLocale();
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (dialog === null) return;

    // `showModal()` rather than the `open` attribute: only the method puts the
    // dialog in the top layer and makes the rest of the page inert. Setting
    // `open` renders a non-modal dialog that looks identical and traps nothing.
    if (bookings !== null && !dialog.open) dialog.showModal();
    if (bookings === null && dialog.open) dialog.close();
  }, [bookings]);

  if (bookings === null) return null;

  return (
    <dialog
      ref={ref}
      // Escape closes it, and the browser fires `cancel` rather than a click on
      // anything. Without this the dialog closes while the caller still thinks
      // it is open, and the next failure would not reopen it.
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onCancel();
      }}
      className="max-w-lg rounded-xl border border-line bg-surface p-6 text-ink backdrop:bg-black/40"
      aria-labelledby="affected-bookings-title"
    >
      <h2 id="affected-bookings-title" className="font-display text-lg font-bold">
        {t("affectedTitle", { count: bookings.length })}
      </h2>

      <p className="mt-2 text-sm text-ink-muted">{t("affectedExplanation")}</p>

      <ul className="my-4 flex max-h-64 flex-col gap-2 overflow-y-auto">
        {bookings.map((booking) => (
          <li key={booking.id} className="rounded-lg border border-line px-3 py-2 text-sm">
            <p className="font-medium">
              <time dateTime={booking.startAt}>
                {new Intl.DateTimeFormat(locale, {
                  dateStyle: "full",
                  timeStyle: "short",
                }).format(new Date(booking.startAt))}
              </time>
            </p>
            <p className="text-ink-muted">
              {/* The name is absent when the caller may change this schedule
                  but not read its bookings. Dropped rather than replaced with a
                  placeholder: the reference already identifies the row, and
                  "Hidden ·" would only draw attention to what is missing. */}
              {booking.customerName === null ? null : `${booking.customerName} · `}
              {booking.serviceName} · {booking.reference}
            </p>
            <p className="text-ink-subtle text-xs">
              {booking.reason === "BLOCKED_BY_EXCEPTION"
                ? t("reasonBlocked")
                : t("reasonOutsideHours")}
            </p>
          </li>
        ))}
      </ul>

      {/* What the clinic still has to do, said plainly: nothing here contacts
          anybody. Saving leaves the appointments standing and the customers
          unaware, which is a fact the person clicking needs before they click. */}
      <p className="text-sm text-ink-muted">{t("affectedNoNotice")}</p>

      <div className="mt-5 flex flex-wrap justify-end gap-2">
        <Button variant="secondary" onClick={onCancel} disabled={busy}>
          {t("affectedCancel")}
        </Button>
        <Button onClick={onConfirm} disabled={busy}>
          {busy ? t("saving") : t("affectedConfirm")}
        </Button>
      </div>
    </dialog>
  );
}
