This is the execution record for adopting shadcn/ui in `apps/web`. Phase 11 built a hand-made component
library on its own token layer; this replaces those components with shadcn's, one family at a time,
without giving up the token layer or the accessibility decisions phase 11 recorded.

# Phase 11 — shadcn/ui adoption

## Implementation Record

**Document version:** 0.1 — started 2026-10-03. **In progress** (steps 0–5 done).
**Scope:** `apps/web/src/components/ui/` and its call sites; `globals.css`'s alias layer; `components.json`.
**Depends on:** [phase-11-gui-redesign.md](phase-11-gui-redesign.md), whose §2.2, §2.4 and §2.6 this must
not break.
**Exit criteria:** every primitive in `components/ui/` is a shadcn component or a thin composition of one ·
no phase-11 §2.6 decision reversed · `globals.contrast.test.ts` green, including the alias-layer block ·
`pnpm lint && pnpm check-types && pnpm test` green after every step.

---

# 1. Why

Phase 11 gave the app a palette and a small library (Button, Input, Select, Field, Card, Badge, Callout,
Table). It is correct but thin: every new need — a tooltip, tabs, a confirmation — meant writing a
primitive from nothing. shadcn's components are copied into the repo as source, so they are ours to edit,
and they bring Radix's keyboard and focus behaviour with them.

# 2. The decisions

## 2.1 A token bridge, not a second palette

shadcn components read `bg-background`, `text-muted-foreground`, `border-input`, `ring-ring` and so on.
Those names are **aliases** onto the phase-11 tokens, declared once in a plain `:root` block at the end of
`globals.css` (`--background: var(--surface)`, `--input: var(--line-strong)`, …) and exposed through the
existing `@theme inline` block. Nothing is duplicated per theme: each alias points at a token the three
theme blocks already flip, so the contrast test's coverage carries over. A test block in
`globals.contrast.test.ts` asserts that every alias is a bare `var()` onto a theme token and that no theme
block redeclares one.

Two mappings are load-bearing: **`--input` is `--line-strong`**, because shadcn draws every control's edge
with `border-input` and that edge must clear WCAG 1.4.11's 3:1 (phase-11 §2.3.1); and **`--ring` is
`--focus-ring`**.

**Never run `shadcn init`** — it rewrites `globals.css` with its own palette. `components.json` is
hand-written. After every `shadcn add`, read `git diff src/app/globals.css` and revert anything it injected.

## 2.2 The booking-page colour is now `booking`, not `accent`

shadcn uses `accent` for its hover/highlight surface in nearly every component. Phase 11 had given that
name to the public booking page's ramp (§2.2 there). Editing every copied component to avoid the name would
be undone by the next `shadcn add`, so the booking ramp moved instead: `--color-accent-*` → `--color-booking-*`
and `--accent`, `--on-accent`, `--accent-surface`, … → `--booking`, `--on-booking`, `--booking-surface`, ….
Three components (`booking-flow`, `booking-calendar`, `manage-booking`) and `book/page.tsx`'s white-label
seam changed. **The rule itself is unchanged**: product chrome never references `booking-*`, the booking
page never references `brand-*`.

## 2.3 Phase-11 §2.6 stands

Decided with the owner on 2026-10-03:

- **Selects stay native** — shadcn's `native-select`, never its Radix `Select`.
- **Edit panels stay inline** via `useEditPanel`. `Dialog` / `AlertDialog` replace only modals that already
  exist (`affected-bookings-dialog.tsx`, confirmation prompts).
- Radix UI is the primitive library.
- Call sites use **shadcn's API** (`variant="default" | "outline" | "ghost" | "destructive"`), migrated in
  the same step that replaces each component.

## 2.4 What every copied component is checked for

shadcn's defaults conflict with four phase-11 commitments; each `add` is reviewed for them:

1. **Focus stays visible.** Remove `outline-none` and any `ring-ring/50` — a 50 % ring fails 3:1. The
   global `:focus-visible` outline in `globals.css` then applies.
2. **44px targets.** Default-size controls keep `min-h-11`; shadcn ships `h-9`.
3. **`Button` defaults to `type="button"`** — an accidental submit on the booking form is silent and
   expensive.
4. **Links stay anchors through `@/i18n/navigation`'s `Link`** — `<Button asChild><Link/></Button>`.

Also: `Callout`/`Notice` keep `role="note"` (shadcn `Alert` defaults to `role="alert"`); `ErrorText` keeps
`role="alert"`.

# 3. Steps

| Step | What                                                                                        | State |
| ---- | ------------------------------------------------------------------------------------------- | ----- |
| 0    | This record                                                                                 | done  |
| 1    | `accent` → `booking` rename; alias layer; `tw-animate-css`; `components.json`               | done  |
| 2    | Button (`buttonRecipe` → `buttonVariants`, `ButtonLink` → `asChild`)                        | done  |
| 3    | Input, Textarea, Label, NativeSelect, Field                                                 | done  |
| 3b   | Checkbox / RadioGroup for the 16 raw checkbox and radio inputs                              | done  |
| 4    | Card (keeps `<section>` and the `useEditPanel` focus contract)                              | done  |
| 5    | Badge (our tones as extra variants), Alert for Callout, Table                               | done  |
| 6    | Dialog / AlertDialog for existing modals only                                               |       |
| 7    | Additive polish, each agreed first: tabs, tooltip, dropdown-menu, sonner, sidebar, skeleton |       |
| 8    | Delete unused wrappers and recipes                                                          |       |

## 3.1 Step 1

No visual change was intended and none should be visible: the radius scale shadcn expects
(`--radius-sm` … `--radius-xl`) is set to Tailwind's own defaults, and the aliases are new names only.
`tw-animate-css` is imported for Radix enter/exit animations. Verified with `pnpm check-types`, `pnpm lint`,
`pnpm test` (332 → 335 tests) and a production `next build`.

# 4. Verification, every step

- `pnpm --filter @bam/web lint && pnpm --filter @bam/web check-types && pnpm --filter @bam/web test`
- `pnpm --filter @bam/web test:e2e`
- By hand: light, dark, forced-light on a dark OS; keyboard tab-through with a visible ring; 44px targets at
  phone width; `hu` and `en`.

## 3.2 Step 2 — Button

`ui/button.tsx` is the registry copy with the §2.4 changes, each listed in its header comment. Beyond those:

- **`@/lib/utils` exists only as a re-export of `@/lib/cn`.** With `components.json` pointing `utils` at
  `@/lib/cn`, the CLI rewrote the import to the bare specifier `"cn"`, which does not resolve. The
  conventional path makes every later `add` come out right without hand-fixing.
- **The CLI did not add `class-variance-authority`** to `package.json` although the component imports it;
  it was added by hand. Check `package.json` after every `add`.
- `ButtonLink` and `buttonRecipe` are gone: 10 links became `<Button asChild><Link/></Button>`, and the
  three non-button elements (`patient-qr-codes`, `tenant-app-install`, the Stripe `<a>`) use
  `buttonVariants`. Variants mapped `primary→default`, `secondary→outline`, `danger→destructive`.
- **`--on-primary` on `--danger` is now a tested contrast pair** — the destructive label had never been
  asserted.

Visible changes, intended: corners are `rounded-md` (6px, was 8px); `ghost` buttons are ink-coloured with
a neutral hover rather than primary blue on a blue hover; `outline` has a hairline shadow. Verified with
`check-types`, `lint`, `test` (338), a production build, and `test:e2e` (67 passed).

## 3.3 Step 3 — form controls

Added `input`, `textarea`, `label`, `native-select`, `field` (and `separator`, which `field` pulls in).

- **The CLI's `"cn"` import is a CLI bug, not a config problem.** With `utils` correctly set to
  `@/lib/utils`, `shadcn info` reports the right path and `add` still writes `import { cn } from "cn"` —
  it appears to find the existing `src/lib/cn.ts` and build a bare specifier to it. Worse, on the first
  `add` it then **installed the unrelated npm package `cn@0.4.0`** to satisfy that import; it was removed.
  After every `add`: `sed -i 's#from "cn"#from "@/lib/utils"#' src/components/ui/*.tsx`, and read the
  `package.json` diff.
- **`Field` is shadcn's; our one-liner is `FormField`**, in `ui/form-field.tsx` with `TextField` and
  `ErrorText`. shadcn's `Field` is a container filled with `FieldLabel` / `FieldDescription` /
  `FieldError`; 64 call sites used ours as `<Field id label hint error>`, and spelling the composition out
  at each would repeat the `{id}-hint` / `{id}-error` `aria-describedby` targets 64 times. `FormField` is
  that composition, once.
- **`field.tsx`'s vertical orientation lost `[&>*]:w-full`**, which overrode a control's own width
  (`location-fields.tsx`'s `w-20` / `w-32` inputs). Controls are full-width by their own classes.
- **`NativeSelect`'s `className` styles its wrapper** (full-width by default; `w-auto` inline), because the
  chevron is positioned against the wrapper. **The wrapper is a `<span>`**, since the locale and theme
  switchers nest the select inside its `<label>`. The chevron is not dimmed.
- Input, Textarea and NativeSelect share `controlClasses` from `ui/input.tsx`: `bg-background` in both
  themes (never transparent), `border-input`, `min-h-11`, no focus suppression.
- The four hand-styled `<select>`s — locale switcher, theme toggle, tenant switcher, chat language — are now
  `NativeSelect`. **The sign-out control in `dashboard-shell.tsx` was a hand-styled `<button>` that step 2
  missed** because it never imported `Button`; it is now `<Button variant="outline">`. Other hand-styled
  buttons may exist the same way (the booking flow's are `booking-*` styled on purpose) — step 8 greps for
  them.

Deferred to **3b**: shadcn `Checkbox` is a Radix `<button role="checkbox">`, not an `<input>`, so each of the
16 raw checkboxes/radios changes its `checked`/`onChange` contract and any `FormData` read. That is its own
step.

Visible changes, intended: controls are `rounded-md` with a hairline shadow, text is 14px from `md` up
(16px below, which stops iOS zooming into a focused field), selects show a lucide chevron instead of the
browser's arrow, and labels use shadcn's spacing. Verified with `check-types`, `lint`, `test` (338), a
production build and `test:e2e` (67 passed).

## 3.4 Step 3b — Checkbox and RadioGroup

- **The CLI re-adds the npm package `cn` on every `add`**, not once — it happened again here. The §3.3
  check of the `package.json` diff is not optional.
- 15 checkboxes became `Checkbox`. Each kept its wrapping `<label>`: a Radix checkbox is a `<button>`,
  which is labelable, so the label still names it and still toggles it on click. `onChange` became
  `onCheckedChange`, which receives `boolean | "indeterminate"`, so `event.target.checked` became
  `value === true`. The assistant settings form reads `FormData`; inside a `<form>` Radix renders a hidden
  input with the same `name` and value `"on"`, so `data.get("enabled") === "on"` is unchanged.
- The subscription plan choice is a `RadioGroup`. It replaces the `<fieldset>`/`<legend>` with
  `role="radiogroup"` named by `aria-labelledby` on the visible heading; the selected card takes a
  `border-primary` edge (border only — no new text-on-colour pair to test).
- Both components lost `outline-none` / `ring-ring/50` and the dark `bg-input/30` tint, per §2.4.

**A flaky e2e test was found, and it predates this work.** `staff-pwa.spec.ts`'s "home page explains mobile
access before sign-in: /en" dispatches `beforeinstallprompt` as soon as the server-rendered headings are
visible, but `staff-pwa.tsx` attaches that listener in a `useEffect`, after hydration. When hydration is
late the event is lost and the "Install app" button never appears. It failed in 3 of 4 full-suite runs on a
loaded machine, then passed 3/3 on this tree and 3/3 on the pre-shadcn sources (`2152eae`) under the same
conditions, and 12/12 when run alone. **Fixed after step 4** in the test, not the component: it now re-dispatches the event inside
`expect(…).toPass()` until the button appears. Afterwards: 3/3 full runs and a 12-worker `--repeat-each=2`
stress run (134/134) passed. The same stress run with the old test also passed, so the failure could not be
reproduced on demand that day; the fix stands on reasoning — the test no longer depends on hydration timing
it never waited for — rather than on a before/after measurement.

Verified with `check-types`, `lint`, `test` (338), a production build and `test:e2e` (67 passed, 3 of 3
consecutive runs).

## 3.5 Step 4 — Card

`ui/card.tsx` follows the registry's `card` (compared against `shadcn view card`), with four departures:

- **`Card` renders `<section>`**, not `<div>`, and spreads its props onto it, so `useEditPanel`'s `panelProps`
  (`id`, `ref`, `tabIndex={-1}`) still reach the DOM and the global focus ring still shows where focus
  landed. Five edit panels depend on this.
- **`CardTitle` is an `<h2>`**, not a `<div>` — the registry's would remove every card title from the
  heading outline. Other levels go through `asChild`: `auth-layout.tsx` uses an `<h1>`, and `Section`'s card
  variant now honours `headingLevel`, which the phase-11 version ignored.
- **`CardContent` is `flex flex-col gap-4`**: every card body here is a stack, and the old `Card` spaced its
  children that way.
- **`CardAction` is `flex flex-wrap gap-2`**, so several header buttons wrap on a phone.

All 31 call sites moved from `<Card title description actions>` to `CardHeader` / `CardTitle` /
`CardDescription` / `CardAction` / `CardContent`, by a script that parses balanced JSX braces; the one
`actions` value was then unwrapped by hand. `auth-layout.tsx` was converted by hand — left as it was, it would
have compiled and rendered its form flush against the card's edges, because the registry `Card` pads only
vertically and leaves horizontal padding to its parts.

Visible changes, intended: cards gain shadcn's `shadow-sm`, and the gap between a card's header and its body
is 24px (was 16px). Verified with `check-types`, `lint`, `test` (338) and a production build. `test:e2e`: 67
passed once; twice the §3.4 race failed its one test (66 passed), each time on a run that took ~52 s rather
than ~33 s.

## 3.6 Step 5 — Badge, Alert, Table

Added `badge`, `alert`, `table` (`separator` came with `field` in step 3). The CLI installed the npm package
`cn` again — the third time — and it was removed again.

- **Badge** gains `success`, `warning` and `info`, carried over from the phase-11 tones, and its
  `destructive` is a tinted chip rather than the registry's red fill with white text, which fails on the dark
  theme's bright danger. Call sites: `tone` → `variant`, `neutral` → `secondary`, `danger` → `destructive`.
  `healthTone` in `lib/integration-state.ts` returns variant names now; it spells them as a union rather than
  importing the component's type, so `lib/` still does not depend on `components/`.
- **Callout is gone; `Alert` replaces it**, as `<Alert variant><AlertDescription>…</AlertDescription></Alert>`
  with `action` → `warning`, `danger` → `destructive`, `info` → `default`. It keeps **`role="note"` as the
  default** (the registry's is `alert`), and the three call sites that chose `alert` or `status` keep theirs.
  `AlertDescription` is a block that inherits the tone's colour — the registry's is a grid, which split
  "text <link> text" into three lines, in `text-muted-foreground`, an untested pair on a tinted container.
  `AlertTitle` lost `line-clamp-1`. `CalloutLink` is `AlertLink`.
- **Table**: five hand-built tables (dashboard members, locations, providers, services, platform
  organizations) now use `Table`/`TableHeader`/`TableBody`/`TableRow`/`TableHead`/`TableCell`, with the
  per-cell padding and per-row borders they used to spell out removed. `TableHead` defaults to
  `scope="col"`; `TableCell` dropped the registry's `whitespace-nowrap`, which would stretch a table with an
  address column across several screens. `DataTable` stays as a composite (required hidden caption, framed,
  sunken header) like `FormField`. `booking-calendar.tsx`'s `<table>` is a month grid, not data, and was left
  alone.
- **`RowButton` / `RowLink`** are now the outline button at a compact size. They stay below the 44px target
  as before — two or three per row at 44px would double every table's height.

**Skeleton moved to step 7.** The loading states are a "Loading…" paragraph per screen; a skeleton has to
mirror each screen's layout and still carry text for a screen reader, which is design work per screen rather
than a component swap.

Verified with `check-types`, `lint`, `test` (338), a production build and `test:e2e` (67 passed, 2 of 2 runs).
