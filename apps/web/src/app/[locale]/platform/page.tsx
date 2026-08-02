import { redirect } from "@/i18n/navigation";

/**
 * Kept as a redirect, not deleted.
 *
 * The screen moved to `/admin/platform` when platform administration gained its
 * own section. This URL appears in docs/phase-9-*.md and in the bookmarks of
 * anyone who used it before the move, and a 404 would be an avoidable dead end.
 */
// `Promise<void>`, not `Promise<never>`: `redirect` throws rather than
// returning, but next-intl does not type it that way, so `never` makes the
// function's end point unreachable in fact and reachable to the compiler.
export default async function PlatformPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<void> {
  const { locale } = await params;

  redirect({ href: "/admin/platform", locale });
}
