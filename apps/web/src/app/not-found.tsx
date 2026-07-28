import Link from "next/link";

/**
 * Root-level 404. Required by Next.js for requests that never reach the
 * [locale] segment, so it cannot use next-intl translations.
 */
export default function NotFound(): React.ReactElement {
  return (
    <html lang="hu">
      <body>
        <main className="mx-auto flex min-h-screen max-w-xl flex-col justify-center gap-4 px-6">
          <h1 className="text-2xl font-semibold">404</h1>
          <p className="text-slate-600">This page does not exist. / Ez az oldal nem létezik.</p>
          <Link href="/" className="text-brand-600 underline">
            Home / Kezdőlap
          </Link>
        </main>
      </body>
    </html>
  );
}
