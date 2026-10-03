"use client";

import { useSyncExternalStore } from "react";
import {
  CircleCheckIcon,
  InfoIcon,
  Loader2Icon,
  OctagonXIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { Toaster as Sonner, type ToasterProps } from "sonner";

/**
 * shadcn/ui's Sonner toaster, adapted (phase-11-shadcn-adoption §3.8).
 *
 * **Toasts are for "it worked", and nothing else.** A toast disappears after a
 * few seconds and a touch user cannot hover it to keep it, so anything a person
 * has to read, copy or act on — an invitation link, a payment link, an error —
 * stays inline on the screen. Sonner renders its list inside a polite live
 * region, so the confirmation is announced without stealing focus, and it
 * pauses the timer while the toast is hovered or focused.
 *
 * The registry reads the theme from `next-themes`, which this app does not use:
 * the theme is `data-theme` on `<html>`, falling back to the operating system
 * (phase-11 §2.4). `useResolvedTheme` reads exactly that. Colours come from our
 * tokens through Sonner's CSS variables either way; the theme only decides
 * Sonner's own details, such as the close button.
 */
function subscribe(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  media.addEventListener("change", onChange);
  return () => {
    observer.disconnect();
    media.removeEventListener("change", onChange);
  };
}

function resolvedTheme(): "light" | "dark" {
  const chosen = document.documentElement.dataset.theme;
  if (chosen === "light" || chosen === "dark") return chosen;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function useResolvedTheme(): "light" | "dark" {
  return useSyncExternalStore(subscribe, resolvedTheme, () => "light");
}

function Toaster(props: ToasterProps): React.ReactElement {
  const theme = useResolvedTheme();

  return (
    <Sonner
      theme={theme}
      className="toaster group"
      icons={{
        success: <CircleCheckIcon className="size-4" />,
        info: <InfoIcon className="size-4" />,
        warning: <TriangleAlertIcon className="size-4" />,
        error: <OctagonXIcon className="size-4" />,
        loading: <Loader2Icon className="size-4 animate-spin motion-reduce:animate-none" />,
      }}
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          "--border-radius": "var(--radius)",
        } as React.CSSProperties
      }
      {...props}
    />
  );
}

export { Toaster };
