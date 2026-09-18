---
name: Cobalt Day
colors:
  surface: '#ffffff'
  surface-bright: '#ffffff'
  surface-dim: '#e3e7ef'
  surface-container-lowest: '#ffffff'
  surface-container-low: '#f9fafc'
  surface-container: '#f2f4f9'
  surface-container-high: '#e3e7ef'
  surface-container-highest: '#cdd3df'
  on-surface: '#121926'
  on-surface-variant: '#4b5566'
  inverse-surface: '#212938'
  inverse-on-surface: '#f2f4f9'
  outline: '#677286'
  outline-variant: '#e3e7ef'
  surface-tint: '#1f5cd4'
  primary: '#1f5cd4'
  on-primary: '#ffffff'
  primary-container: '#e0eafd'
  on-primary-container: '#0f398d'
  inverse-primary: '#6f9ff7'
  secondary: '#4b5566'
  on-secondary: '#ffffff'
  secondary-container: '#f2f4f9'
  on-secondary-container: '#374051'
  tertiary: '#0b7643'
  on-tertiary: '#ffffff'
  tertiary-container: '#defae6'
  on-tertiary-container: '#04361f'
  error: '#be0214'
  on-error: '#ffffff'
  error-container: '#ffebe8'
  on-error-container: '#76080c'
  warning: '#845a0f'
  warning-container: '#fef2dd'
  background: '#ffffff'
  on-background: '#121926'
  surface-variant: '#f2f4f9'
rounded:
  sm: 0.375rem
  DEFAULT: 0.5rem
  md: 0.75rem
  lg: 1rem
  xl: 1.25rem
  full: 9999px
spacing:
  unit: 8px
  container-max: 1280px
  gutter: 24px
  margin-mobile: 16px
  margin-desktop: 40px
---

## Brand & Style

This is **booking-and-more**, a multi-tenant appointment-booking SaaS. Two very different audiences share one visual system: the *business* (a clinic owner, a receptionist, a practitioner managing their diary all day) and the *customer* (a stranger on a phone who wants an appointment in under a minute and will never see the product again).

The aesthetic is **Confident Utility** — modern corporate software that feels engineered rather than decorated. Deep cobalt blue carries authority and trust without the coldness of navy or the flippancy of a bright tech blue. The system prizes legibility, density where density helps, and generous whitespace where a decision has to be made. It is deliberately industry-neutral: the same screens must not look wrong for a dental clinic, a barbershop, a physiotherapist or a law practice.

No decorative flourish that does not carry information. No gradients on text. No glassmorphism. No drop shadows used to fake hierarchy that a background shift can express.

## Colors

The palette is a single deep-blue hue with a neutral ramp tinted to that same hue, so greys sit *under* the blue rather than beside it.

- **Primary (Cobalt `#1f5cd4`):** Primary actions, active navigation, selected time slots, focus rings. White text on it reaches 5.93:1. One primary action per view.
- **Primary container (`#e0eafd`):** Selected-but-not-active states, information callouts, the tint behind a chosen slot.
- **Neutral ramp:** Blue-tinted greys from `#f9fafc` to `#060b17`. Body text is `#121926`; secondary text is `#4b5566`; never lighter than `#677286` for text on white.
- **Tertiary / success (`#0b7643`):** Confirmed bookings, active subscriptions, completed steps.
- **Error (`#be0214`):** Cancellations, failed payments, validation.
- **Warning (`#845a0f`):** Expiring holds, pending subscriptions, unsaved changes.
- **Never use a mid-blue for body text.** The `#427cec` step reads as a link colour but fails contrast on white; links are `#1248b1`.

## Typography

**Manrope** for headlines — geometric, confident, tightly tracked at large sizes. **Inter** for body, labels, tables and every number. Both are used with the `latin-ext` subset because the product's default language is Hungarian: `ő` and `ű` must not fall back to a different face mid-sentence.

- Headlines tighten letter-spacing as they grow; body text never does.
- Body text is never below 16px. Table cells and metadata may go to 14px; 12px is reserved for uppercase labels and badge text.
- Numbers (times, prices, durations) use tabular figures so a column of slots aligns.
- Hungarian strings run roughly 20–30% longer than English. Never size a button, tab or badge to its English label.

## Layout & Spacing

A strict **8px grid**. Content is centred at a 1280px maximum; forms and single-column reading content cap at 720px.

- **Desktop:** 12-column grid, 24px gutters, 40px page margins.
- **Mobile:** single column, 16px margins, 44px minimum touch target on every interactive element.
- 16px separates related elements, 32px separates groups, 48px separates page sections.
- The public booking flow is **phone-first**. Assume one thumb and a 375px viewport, then widen.

## Elevation & Depth

Hierarchy comes from **tonal layering first, borders second, shadows last**.

1. **Base:** white page ground.
2. **Card:** white with a 1px `#e3e7ef` border. No shadow.
3. **Raised / sticky:** `#f9fafc` fill with the same border, plus a very soft `0 1px 2px rgba(18,25,38,0.06)`.
4. **Floating (rare):** `0 12px 32px rgba(18,25,38,0.10)`.

Never stack a heavy shadow on a bordered card. If two surfaces need separating, change the background before reaching for a shadow.

## Shapes

- **Cards and panels:** 12px radius.
- **Buttons and inputs:** 8px radius, 44px minimum height.
- **Badges and chips:** full pill radius.
- **Avatars:** circular.
- Never a sharp 0px corner, and never a full pill on anything structural.

## Components

- **Buttons:** Primary = solid cobalt, white text. Secondary = white fill with a `#cdd3df` border and `#121926` text. Ghost = text only, cobalt, underline on hover. Destructive = solid `#be0214`. Disabled reduces opacity but keeps the label legible.
- **Inputs:** White fill, 1px `#cdd3df` border, label always *above* the field, never a placeholder used as a label. Focus is a 2px cobalt ring with a 2px offset — **visible focus is a hard requirement, never removed**. Errors put a `#be0214` border plus a message below, never colour alone.
- **Selects:** Native select controls, styled minimally. Do not draw custom dropdown menus.
- **Cards:** 12px radius, 1px border, 24px internal padding.
- **Tables:** Left-aligned text, right-aligned numbers, 56px row height, a `#f2f4f9` header row, hairline `#e3e7ef` row dividers, and a hover tint of `#f9fafc`. Row actions are compact outline buttons at the row end.
- **Badges:** Pill, 12px semibold text, tinted container background with the matching dark text — success `#defae6`/`#04361f`, error `#ffebe8`/`#76080c`, warning `#fef2dd`/`#845a0f`, neutral `#f2f4f9`/`#374051`. Status is never conveyed by colour alone; the badge always carries a word.
- **Step indicator:** A horizontal numbered rail. Completed steps are filled cobalt with a check, the current step is a cobalt ring, upcoming steps are `#cdd3df` outlines. It is an ordered list, and the current step is marked as such.
- **Time-slot grid:** A responsive grid of equal pill buttons. Available = white with a `#cdd3df` border; selected = solid cobalt with white text; unavailable = `#f2f4f9` fill, `#677286` text, still legible, never invisible.
- **Empty states:** A centred icon in a `#e0eafd` circle, a one-line heading, a sentence of explanation, and the single action that resolves it.
- **Navigation:** A horizontal tab rail under the page header, with a 2px cobalt underline on the active item. Items the current user cannot yet reach are shown greyed with an explanation below the rail, not hidden silently.

## Accessibility

WCAG 2.1 AA is a requirement, not an aspiration.

- Every text pair reaches 4.5:1; every focus ring and control border reaches 3:1.
- Focus is always visible and never removed.
- Every icon-only control carries a text label for assistive technology.
- Every form control has a real, associated label positioned above it.
- Status, availability and validity are always carried by text or shape as well as colour.
