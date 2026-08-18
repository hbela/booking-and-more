import { THEME_PREFERENCE_COOKIE } from "./theme-preference";

/**
 * The blocking script that stamps `data-theme` on `<html>` before first paint.
 *
 * ## Why a script and not the server
 *
 * The obvious implementation is `cookies()` in `[locale]/layout.tsx`. It is
 * also the wrong one: reading a cookie opts the whole locale layout into
 * dynamic rendering, which defeats `generateStaticParams` and
 * `setRequestLocale` for every route beneath it — and a cached response would
 * still carry one visitor's theme to the next.
 *
 * So the document stays static and one tiny synchronous script personalises it.
 * It runs before the browser paints, so there is no flash; it is deliberately
 * placed in `<head>` for that reason, and must not be deferred.
 *
 * ## Why it is a string
 *
 * `dangerouslySetInnerHTML` is the only way to emit a synchronous inline
 * script from React. There are two documents that need it — `[locale]/layout.tsx`
 * and `app/not-found.tsx`, which sits above the locale segment and has no
 * layout of its own — so it lives here once rather than being typed twice and
 * drifting.
 *
 * ## Who emits it
 *
 * `components/theme-script.tsx`, through `useServerInsertedHTML`, and **not** a
 * `<script>` element in either document. Both rendered one directly until
 * 2026-08-17, when React began reporting that a script rendered by a component
 * cannot execute on the client: changing the `[locale]` segment's value remounts
 * that layout, and React builds a `<div>` rather than a script on that path.
 * The full reasoning, including why `next/script` is the wrong instrument, is in
 * that file.
 *
 * ## Content Security Policy
 *
 * `proxy.ts` creates one nonce per document request. Both document call sites
 * read it from `x-nonce` and pass it through `ThemeScript`, matching the nonce
 * Next applies to its own streamed bootstrap scripts.
 *
 * The `catch` is not defensive padding: `document.cookie` throws in some
 * embedded and privacy-restricted contexts, and an exception here would abort
 * the parser before `<body>`. Failing to a system-themed page is fine; failing
 * to a blank one is not.
 */
export const THEME_SCRIPT = `try{var m=document.cookie.match(/(?:^|; )${THEME_PREFERENCE_COOKIE.replaceAll(".", "\\.")}=(light|dark)/);if(m)document.documentElement.dataset.theme=m[1]}catch(e){}`;
