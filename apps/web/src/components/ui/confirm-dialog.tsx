"use client";

import { useCallback, useRef, useState } from "react";
import { useTranslations } from "next-intl";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "./alert-dialog";

export interface ConfirmRequest {
  /** The question itself, e.g. "Archive Dr. Kovács?". It is the dialog's title. */
  title: string;
  /** Consequences worth a second line. Optional: most questions say it all. */
  description?: string | undefined;
  /**
   * The confirming button. Reuse the label of the button the user just
   * clicked ("Archive", "Revoke") — a bare "OK" makes them re-read the title
   * to learn what they are agreeing to.
   */
  confirmLabel: string;
  /** Paint the confirming button `destructive` — for archiving, revoking, unlinking. */
  destructive?: boolean | undefined;
  onConfirm: () => void;
}

/**
 * A styled, translated replacement for `window.confirm()`
 * (phase-11-shadcn-adoption §3.7).
 *
 * The browser's dialog could not be styled, put its buttons in the browser's
 * language rather than the page's, and froze the tab while open. This is
 * shadcn's `AlertDialog`: focus moves into it, Escape and the Cancel button
 * both decline, the page behind is inert, and focus returns to the row button
 * that asked.
 *
 * It is **not** an edit dialog. Phase-11 §2.6 still stands — editing happens in
 * inline panels via `useEditPanel`. This only replaces a confirmation that was
 * already modal.
 *
 * ```tsx
 * const { confirm, confirmDialog } = useConfirm();
 * <RowButton onClick={() => confirm({ title, confirmLabel, destructive: true, onConfirm })} />
 * {confirmDialog}
 * ```
 */
export function useConfirm(): {
  confirm: (request: ConfirmRequest) => void;
  confirmDialog: React.ReactElement;
} {
  const t = useTranslations("common");
  const [open, setOpen] = useState(false);
  // Kept after closing so the title does not blank out during the fade-out.
  const [request, setRequest] = useState<ConfirmRequest | null>(null);
  // The action button both runs `onConfirm` and closes the dialog, which fires
  // `onOpenChange(false)` too. The ref makes the first of those the only one.
  const settled = useRef(false);

  const confirm = useCallback((next: ConfirmRequest) => {
    settled.current = false;
    setRequest(next);
    setOpen(true);
  }, []);

  const confirmDialog = (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          settled.current = true;
          setOpen(false);
        }
      }}
    >
      <AlertDialogContent
        // Radix warns when content has no description; most questions here
        // are complete as a title, so say so explicitly rather than invent one.
        {...(request?.description === undefined ? { "aria-describedby": undefined } : {})}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>{request?.title}</AlertDialogTitle>
          {request?.description === undefined ? null : (
            <AlertDialogDescription>{request.description}</AlertDialogDescription>
          )}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
          <AlertDialogAction
            variant={request?.destructive ? "destructive" : "default"}
            onClick={() => {
              if (settled.current || request === null) return;
              settled.current = true;
              request.onConfirm();
            }}
          >
            {request?.confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );

  return { confirm, confirmDialog };
}
