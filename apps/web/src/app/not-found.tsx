import Link from "next/link";
import { ThemeScript } from "@/components/theme-script";
import "./globals.css";

/**
 * Root-level 404. Required by Next.js for requests that never reach the
 * [locale] segment, so it cannot use next-intl translations — hence the
 * bilingual literals below, which are the only hard-coded user-facing strings
 * in the app.
 *
 * It is its own document. There is no root layout (the only layout in the app
 * is `[locale]/layout.tsx`), so nothing above this file supplies `<html>`, the
 * stylesheet or the theme script, and each has to be repeated here. That is why
 * the import of `globals.css` matters: without it every Tailwind class on this
 * page was inert, and this screen rendered unstyled.
 */
export default function NotFound(): React.ReactElement {
  return (
    <html lang="hu" suppressHydrationWarning>
      <ThemeScript />
      <body>
        <main className="mx-auto flex min-h-screen max-w-xl flex-col justify-center gap-4 px-6">
          <p className="font-display text-sm font-semibold tracking-widest text-primary uppercase">
            404
          </p>
          <h1 className="font-display text-3xl font-bold tracking-tight text-ink">
            Ez az oldal nem létezik. / This page does not exist.
          </h1>
          <p className="text-ink-muted">
            Lehet, hogy elírás történt, vagy az oldalt áthelyeztük. / The address may be mistyped, or
            the page may have moved.
          </p>
          <Link
            href="/"
            className="text-primary hover:text-primary-hover self-start font-medium underline underline-offset-4"
          >
            Kezdőlap / Home
          </Link>
        </main>
      </body>
    </html>
  );
}
