// PARKED 2026-08-17 — Epic 6 part 1, Google Calendar.
//
// The folder is `_integrations`, not `integrations`: a leading underscore is
// Next's private-folder convention, so this file is compiled and typechecked
// but is not a route. Un-parking is `git mv _integrations integrations` plus
// the nav item in `components/dashboard-shell.tsx` and the API registration in
// `apps/api/src/app.ts`. The screen and its state machine are unchanged and
// still tested (`lib/integration-state.test.ts`).

import { setRequestLocale } from "next-intl/server";
import { IntegrationsScreen } from "@/components/integrations-screen";

export default async function IntegrationsPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<React.ReactElement> {
  const { locale } = await params;
  setRequestLocale(locale);

  return <IntegrationsScreen />;
}
