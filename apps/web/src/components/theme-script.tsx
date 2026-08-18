"use client";

import { useRef } from "react";
import { useServerInsertedHTML } from "next/navigation";
import { THEME_SCRIPT } from "@/lib/theme-script";

/**
 * Emits the pre-paint theme script into the document, once, server-side only.
 *
 * ## Why this is not just `<script dangerouslySetInnerHTML>` in the layout
 *
 * It was, until React reported: *"Encountered a script tag while rendering
 * React component. Scripts inside React components are never executed when
 * rendering on the client."*
 *
 * React treats `<html>`, `<head>` and `<body>` as document singletons and never
 * recreates them, but a `<script>` child of one is an ordinary element. So when
 * the `[locale]` segment's *value* changes — which is exactly what the locale
 * switcher does — that layout subtree remounts and React takes the
 * client-create path for the script. There it deliberately builds a `<div>`
 * instead, because a script node created by `createElement` never executes, and
 * warns. Harmless for the theme, which was applied at first parse and is not
 * undone; noisy, and the replacement element is real.
 *
 * The honest reading is that this script belongs to the *document*, not to the
 * React tree: it must run once, at parse time, and has nothing to say to any
 * later render. `useServerInsertedHTML` says precisely that — the callback runs
 * only while streaming the server response, and the component itself renders
 * `null` in both environments, so there is no host element to recreate, no
 * hydration mismatch, and no warning.
 *
 * ## Why not `next/script`
 *
 * `strategy="beforeInteractive"` with inline content does **not** emit a
 * parser-blocking script. It pushes the source onto Next's `self.__next_s`
 * queue for its own runtime to execute, which happens after bootstrap — so the
 * visitor sees the system theme first and then a flip. That is the exact flash
 * this whole mechanism exists to prevent, so the Next-blessed API is the wrong
 * one here.
 *
 * Every other constraint is unchanged and documented in lib/theme-script.ts:
 * synchronous, never deferred, and the reason it cannot be done server-side.
 */
export function ThemeScript({ nonce }: { nonce?: string | undefined }): null {
  /**
   * The callback runs on **every stream flush**, not once per request — the
   * same reason the CSS-in-JS integrations Next documents all carry a flag like
   * this one. Unguarded it emitted the script twelve times into a single
   * document. Idempotent, so nothing misbehaved, which is exactly why it would
   * have survived review.
   *
   * A ref rather than a module-level flag: the module is shared by every
   * request the server process handles, so a module-level flag would emit for
   * the first visitor after a boot and for nobody afterwards. The ref belongs
   * to one render of one request.
   */
  const emitted = useRef(false);

  useServerInsertedHTML(() => {
    if (emitted.current) return null;
    emitted.current = true;

    // The payload is a build-time constant with no interpolation, so there is
    // nothing here for a value to be injected into. See lib/theme-script.ts.
    return <script nonce={nonce} dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />;
  });

  return null;
}
