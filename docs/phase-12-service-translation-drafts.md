# Phase 12 — Service translation drafts

## Implementation Record

**Document version:** 1.0 — built 2026-10-05.
**Scope:** a "Draft from {default language}" button per language in a service's Translations panel.
**Depends on:** [Phase 12 §8.4 / §7.4](phase-12-assistant-knowledge-consistency.md) (translation drafts
for the company profile and FAQs).
**Status:** record. Not yet run against the real model, like the rest of phase 12.

# 1. What was asked

The owner writes the company profile, service names and descriptions, and FAQs in Hungarian, and wants
to translate them into English, German or French, one language at a time, with a button next to the
"EN — Name" field.

Phase 12 part 4 had already built this for the **profile** (a button under each language's field) and
the **FAQs** (a target-language picker that returns a list to add one by one). **Services were the gap.**
Their translations live in `service_translations` (tech-impl §38) and are edited on the Services screen,
which had no draft action. This record covers only that gap.

# 2. Decisions

## 2.1 One endpoint, a third kind

`POST /v1/assistant/knowledge/translation-draft` now accepts `{ target, kind: "SERVICE", serviceId }`.
The request is a discriminated union on `kind`, so `serviceId` is required for `SERVICE` and absent for
the other two kinds. The response gains `service: { name, description | null } | null`.

A second endpoint would have needed a second copy of everything §7.4 already gets right: metering
through the chat's reserve → call → reconcile, the all-or-nothing rule (a draft missing a piece is a
503), the `ASSISTANT_MANAGE` guard plus the plan check, and the audit entry. The audit entry now also
records `serviceId`.

The service is read with `{ id, tenantId }` (rule 5). Another tenant's service is the same
`SERVICE_NOT_FOUND` 404 as one that does not exist. The source text is `services.name` / `.description`,
which are the default language by definition (schema comment on `Service.name`). An empty description
is not sent, and comes back as `null`.

## 2.2 A service's own name is translated; a name in prose is not

The translate prompt says to keep "names of … booked services as written". That is right inside the
profile, which mentions services by name, but it would leave a service's own name untranslated, which
defeats the point. The name therefore travels as its own item, `service:service-name`, and the prompt
has a rule that an item whose id ends in `:service-name` is a menu entry to translate naturally.

The rule is keyed on the id, not the kind, so a profile draft behaves exactly as before.

## 2.3 Who sees the button

The button is shown only when `me.features.assistant` and `assistant:manage` both hold, which is the
route's own guard. An owner on a plan without the assistant still edits translations by hand, as
before, and never sees a button that would 403. The default language has no button: it is the source,
and it is edited in the main service form.

## 2.4 Behaviour copied from the profile drafts

The profile drafts set these rules, and they stand unchanged here:

- **Nothing is saved.** The draft fills the name input and the description textarea. The owner saves
  through the panel's ordinary `PUT …/translations`, which still runs the character budget.
- **It asks before overwriting.** A language with an existing name or description asks first, through
  `useConfirm`.
- **A marker until edited.** "Machine-translated from Hungarian…" stays until the owner types in
  either field. `fill` dispatches an untrusted `input` event, which does not count as typing. `fill`
  and `without` moved from `business-knowledge.tsx` to `lib/fill-field.ts`, so both editors share them.
- **The button sits outside the `<label>`,** so it is not part of the field's accessible name. That is
  the same fix part 4 made to the profile fields.

Copy reuses `businessKnowledge.draft.*`. The one new key is `catalogue.draftOverwrite`, because the
confirmation names both fields.

# 3. Verified

- `@bam/ai`: the prompt test asserts the service-name rule.
- API `knowledge-ai.test.ts` (6 tests, against the test database): a name and description are drafted
  without writing a `service_translations` row; a name-only service returns `description: null`; another
  tenant's service is 404 `SERVICE_NOT_FOUND`; a missing `serviceId` is 422.
- Web e2e `knowledge-health.spec.ts`, in both locales: three buttons (EN/DE/FR, none for HU); an empty
  language fills at once and is marked; an existing translation asks first; Save sends the drafted
  values, and only then.
- Web: 339 unit tests, lint and typecheck clean.

# 4. Not done

- **No "translate all languages at once" button.** That would be three model calls behind one click.
  The request was to translate selectively, one language at a time.
- **No bulk "translate every service".** Each service is drafted from its own panel. A catalogue-wide
  draft would be one large call that has to be all or nothing across services, and it is not needed
  yet.
