"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export interface EditPanel {
  /** The row currently open, or null. */
  openId: string | null;
  /** Open this row, or close it if it is already open. */
  toggle: (id: string) => void;
  close: () => void;
  /** Spread onto the panel element so focus and labelling work. */
  panelProps: { id: string; ref: React.RefObject<HTMLElement | null>; tabIndex: -1 };
  /** Spread onto the row's trigger button. */
  triggerProps: (id: string) => { "aria-expanded": boolean; "aria-controls": string };
}

/**
 * One open editing panel per screen, with the focus wiring a dialog would give
 * us for free.
 *
 * There is no Dialog primitive here and there is not going to be one — the
 * screens use an inline `Card` toggled by state. What that pattern loses is
 * everything a dialog does about focus: before this hook, pressing "Assign"
 * rendered a panel below the fold and left the caret on the button, so for a
 * keyboard or screen-reader user *nothing observable happened*. So the panel
 * takes focus on open and hands it back on close, and the trigger announces
 * what it controls.
 *
 * `scrollIntoView` uses `block: "nearest"`, which does nothing when the panel is
 * already visible — the common case on a short list, where scrolling would be
 * an unexplained jump.
 *
 * Moved here from `dashboard-shell.tsx` in phase 11: it is behaviour, not
 * chrome, and it is what the whole `ui/card.tsx` focus contract exists to
 * serve. Re-exported from its old home while the screens migrate.
 */
export function useEditPanel(name: string): EditPanel {
  const [openId, setOpenId] = useState<string | null>(null);
  const panelRef = useRef<HTMLElement | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const panelId = `${name}-edit-panel`;

  // After the panel mounts, not during the click that opened it.
  useEffect(() => {
    if (openId === null) return;

    panelRef.current?.focus();
    panelRef.current?.scrollIntoView({ block: "nearest" });
  }, [openId]);

  const close = useCallback(() => {
    setOpenId(null);
    // Focus would otherwise fall back to <body>, stranding a keyboard user at
    // the top of the document with no idea where they were.
    triggerRef.current?.focus();
  }, []);

  const toggle = useCallback((id: string) => {
    setOpenId((current) => (current === id ? null : id));
    triggerRef.current = document.activeElement as HTMLElement | null;
  }, []);

  const triggerProps = useCallback(
    (id: string) => ({ "aria-expanded": openId === id, "aria-controls": panelId }),
    [openId, panelId],
  );

  return {
    openId,
    toggle,
    close,
    panelProps: { id: panelId, ref: panelRef, tabIndex: -1 },
    triggerProps,
  };
}
