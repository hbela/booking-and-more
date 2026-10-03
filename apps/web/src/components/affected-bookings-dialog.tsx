"use client";

import { useLocale, useTranslations } from "next-intl";
import type { AffectedBooking } from "@bam/contracts";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "./ui/alert-dialog";
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
 * ## An AlertDialog, because this is a decision
 *
 * Formerly a native `<dialog>` with `showModal()`; now shadcn's `AlertDialog`
 * (phase-11-shadcn-adoption §3.7), which keeps everything that was chosen for:
 * the focus trap, Escape, the inert background and `aria-modal`. An
 * `AlertDialog` rather than a `Dialog` because it does not close on a click
 * outside — the clinic has to choose, exactly as with `showModal()`.
 *
 * Neither button is an `AlertDialogAction` / `AlertDialogCancel`: those close
 * the dialog themselves, and confirming here starts a save that the caller
 * ends by passing `null`. Escape goes through `onOpenChange`, and is ignored
 * while that save is in flight.
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
}): React.ReactElement {
  const t = useTranslations("availability");
  const locale = useLocale();
  return (
    <AlertDialog
      open={bookings !== null}
      onOpenChange={(open) => {
        if (!open && !busy) onCancel();
      }}
    >
      {bookings === null ? null : (
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("affectedTitle", { count: bookings.length })}</AlertDialogTitle>
            <AlertDialogDescription>{t("affectedExplanation")}</AlertDialogDescription>
          </AlertDialogHeader>

          <ul className="flex max-h-64 flex-col gap-2 overflow-y-auto">
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

          <AlertDialogFooter>
            <Button variant="outline" onClick={onCancel} disabled={busy}>
              {t("affectedCancel")}
            </Button>
            <Button onClick={onConfirm} disabled={busy}>
              {busy ? t("saving") : t("affectedConfirm")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      )}
    </AlertDialog>
  );
}
