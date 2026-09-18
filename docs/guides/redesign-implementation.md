# Booking and More — Cobalt Day redesign

Implemented on `design/app-redesign`, following [design.md](./design.md).

## First release

- Public booking: product signature, tenant heading, numbered progress rail, selected-service summary, clearer service choices, pill time slots, and a 720px reading width. Mobile shows the active step label beneath the five numbered markers.
- Chat: product and business identity, a structured assistant header, readable 16px messages, visible input labels, and the booking-form fallback. Existing sessions, language selection, streaming, and confirmation actions retain their behavior.
- Owner dashboard: a 1280px workspace, current-section heading, horizontal navigation, permission-aware booking/availability/assistant shortcuts, side-by-side business knowledge panels on large screens, and a bordered members table.
- Identity: reusable calendar-plus SVG mark, theme-aware wordmark component, and matching favicon. Interface icons use the existing Lucide family.

The shared light-theme tokens now match Cobalt Day. Dark-theme colors remain unchanged. Shared tokens, branding, dashboard shell, and language/theme controls also affect existing screens that consume them; this release does not rebuild those screens.

## Accessibility decisions

The specification gives pale control borders and also requires 3:1 control contrast. Retain the existing, stronger control-border token to satisfy that requirement. Native selects, visible focus rings, translated labels, and permission/subscription gates remain in place. Language and theme controls now have 44px minimum height. Cards use borders and tonal surfaces rather than shadows.

## Review checklist

- Review booking at 375px and desktop widths in Hungarian and English, including service/provider selection, empty availability, hold expiry, details, and confirmation.
- Review chat in all four chat languages, including unavailable state, long messages, catalogue choices, slot choices, confirmation, and embedded-widget sizing.
- Review the owner overview and navigation in both themes; check tenant switching, pending subscriptions, and staff roles with fewer permissions.
- Run web lint, type-check, tests (including contrast), and production build.

Validation on 18 September 2026: web lint and type-check passed; all 294 tests passed, including theme contrast checks; the production build passed with network access for the existing Google Fonts downloads.

Visual browser review is pending because the browser connection was unavailable during implementation. No production deployment or live booking was performed.
