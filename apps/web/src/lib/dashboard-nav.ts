import type { MeResponse } from "./api-client";
import { diaryScopeFor, hasAnyDiary, hasPersonalDiary } from "./delegation";

/**
 * Which navigation items a caller gets, and in what order.
 *
 * Pure and in `lib/` for the same reason `member-diary.ts` and
 * `working-hours.ts` are: it is the decision, and decisions get unit tests.
 * `dashboard-shell.tsx` renders what this returns and adds nothing to it.
 *
 * Nothing here stops anything — the API re-authorises every request. What it
 * prevents is a link that 403s, which is the failure
 * docs/phase-9-provider-onboarding.md §2.9 removed for owners and
 * docs/phase-3-4-diary-delegation.md §6.3 had to remove again for the front
 * desk.
 */

/**
 * `alwaysAvailable` marks the two destinations that survive the activation gate
 * (phase-9 §2.11): the overview, which explains the situation, and the
 * subscription screen, which resolves it. Everything else needs a tenant that
 * accepts writes.
 *
 * `permissions` is **any one of these**, and a caller holding none of them does
 * not see the item at all. That is deliberately the opposite of the activation
 * gate in `dashboard-shell.tsx`, which disables and explains: that gate is
 * temporary and the user can resolve it, so naming the reason is useful. A
 * permission somebody will never hold is not actionable, and an item announcing
 * it on every page load is noise (phase-9-provider-onboarding §2.9).
 *
 * `requires` is the second gate, and since diary delegation the more important
 * one. A permission no longer implies a usable screen: three of the four
 * booking and availability permissions authorise nothing by themselves, so
 * holding one says only that the caller *could* be given a diary. Whether they
 * have been is a question about data, and only this can ask it.
 *
 * Both gates are advisory, like every other affordance here — the API
 * re-authorises each request, so hiding an item has never been what stops
 * anything. The permission literals are strings rather than `Permissions.*`
 * because `@bam/auth` is not a dependency of this app; the risk that a typo
 * silently hides an item is recorded in phase-9-provider-onboarding §7.
 */
interface NavItem {
  href: string;
  /** Message key under the `dashboard` namespace. */
  key: string;
  alwaysAvailable: boolean;
  /** Any one of these. `null` means the item is not permission-gated. */
  permissions: string[] | null;
  /** An extra condition on the caller's data. Absent means no extra condition. */
  requires?: (me: MeResponse | null | undefined) => boolean;
}

/**
 * Every item, in the order they are shown.
 *
 * Declared in one ordered array rather than assembled by splicing, so the order
 * is readable here and cannot drift with an index that has to be recounted
 * every time an item's gate changes.
 */
const NAV: NavItem[] = [
  // Ungated on purpose. It is the only screen guaranteed reachable —
  // `landingFor()` sends everyone here, and so does the sign-in redirect — so
  // an unreachable current page would be a worse failure than a spare item.
  { href: "/dashboard", key: "overview", alwaysAvailable: true, permissions: null },
  {
    href: "/dashboard/subscription",
    key: "subscription",
    alwaysAvailable: true,
    permissions: ["billing:manage"],
  },
  // Bookings sit first among the gated items, ahead of the catalogue: the
  // catalogue is configured once and the diary is looked at every day.
  //
  // Gated by data as well as by permission. An ASSISTANT holds
  // `booking:read:delegated` from the moment they join and reaches nothing
  // until a provider hands them a diary; a PROVIDER holds `booking:read:own`
  // whether or not their membership names one. In both cases the list 403s,
  // and a clickable link that 403s is exactly what §2.9 removed for owners
  // (docs/phase-3-4-diary-delegation.md §6.3).
  //
  // `hasAnyDiary` rather than `hasPersonalDiary`: an administrator has no diary
  // of their own and this screen is still genuinely theirs — the whole
  // organization's day.
  {
    href: "/dashboard/bookings",
    key: "bookings",
    alwaysAvailable: false,
    permissions: ["booking:read:all", "booking:read:own", "booking:read:delegated"],
    requires: (me) => hasAnyDiary(diaryScopeFor(me, "booking:read:all", "BOOKINGS")),
  },
  // The catalogue then runs in the order it has to be built, which is not the
  // order it was written in. A provider is booked *for a service*, so a provider
  // created first has nothing to offer and cannot appear on the booking page;
  // availability comes last because it needs a provider to belong to. Locations
  // sit next to services because both stand alone — neither needs anything else
  // to exist first.
  {
    href: "/dashboard/services",
    key: "services",
    alwaysAvailable: false,
    permissions: ["service:manage"],
  },
  {
    href: "/dashboard/locations",
    key: "locations",
    alwaysAvailable: false,
    permissions: ["location:manage"],
  },
  {
    href: "/dashboard/providers",
    key: "providers",
    alwaysAvailable: false,
    permissions: ["provider:manage"],
  },
  // PARKED 2026-08-17 — Epic 6 part 1. The route itself is parked as
  // `_integrations` (Next's private-folder convention), so this item would
  // 404; the `integrations` message keys stay in en.json and hu.json.
  //
  // Google Calendar, after the catalogue: a connection is aimed at a provider's
  // diary, so there has to be one to aim at. Both scopes, like bookings — a
  // provider connects their own account, an administrator connects anyone's
  // (docs/phase-6-google-calendar-part-1.md §7.9). An ASSISTANT holds neither
  // and does not see the item: a connected calendar is a setting, and settings
  // are not delegated (phase-3-4-diary-delegation §2.4).
  //
  // {
  //   href: "/dashboard/integrations",
  //   key: "integrations",
  //   alwaysAvailable: false,
  //   permissions: ["integration:manage:all", "integration:manage:own"],
  // },
  //
  // Availability is last and is *not* permission-gated, because no permission
  // is the right test. It belongs to a provider rather than to the
  // organization: an owner reaches one diary at a time from the row on
  // Providers, and a top-level entry implied the owner fills it in, which is
  // the opposite of who decides (phase-2-3 §2.7).
  //
  // So the condition is data, and `hasPersonalDiary` is false for an
  // administrator on purpose. Diary delegation adds a third way to earn the
  // item — a grant — and does not change that.
  {
    href: "/dashboard/availability",
    key: "availability",
    alwaysAvailable: false,
    permissions: null,
    requires: (me) => hasPersonalDiary(me, "AVAILABILITY"),
  },
];

/**
 * The items this caller gets, in order, both gates applied.
 *
 * One function answers the whole question, so "which items does this person
 * get" has a single testable answer rather than half of one here and half in
 * the JSX.
 */
export function navFor(me: MeResponse | null | undefined): NavItem[] {
  const held = (permission: string): boolean => me?.permissions.includes(permission) ?? false;

  return NAV.filter(
    (item) =>
      (item.permissions === null || item.permissions.some(held)) &&
      (item.requires === undefined || item.requires(me)),
  );
}
