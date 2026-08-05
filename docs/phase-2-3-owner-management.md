This is the execution record for the slice that finishes Epics 2 and 3 on the web side, derived from
PRD.md §9.3–9.6 and technical-implementation.md §28 (staff routes).

# Owner management of services, providers, locations and availability

## Implementation Record

**Document version:** 1.0 — built and tested 2026-08-03. The automated suites pass; the manual walk in
§6.2 has **not** been performed.
**Scope:** full create-and-edit for providers, services and locations; per-provider service overrides;
location-scoped and date-bounded working hours; availability exceptions in the provider's timezone, with
editing; archive/restore. **Out of scope:** cursor pagination (deferred, §5.1), a calendar view (Epic 6).
**Depends on:** [phase 2](phase-2-providers-services-locations.md) for the catalogue API and the two-flag
model · [phase 3](phase-3-availability-engine.md) for working hours, exceptions and `zone.ts` ·
[phase 9 — subscription and activation](phase-9-subscription-and-activation.md) for the gate that decides
when these screens are reachable at all
**Exit criteria:** an owner can configure a clinic entirely from the dashboard · no save silently discards
data · an accidental archive is recoverable · every time is stored in the zone the user meant

---

# 1. Context

Epic 9 was built out of order because onboarding gates every other screen, and it is done: there are paying
subscribers. What they unlock is four screens that Epic 2 and Epic 3 left half-finished — and "half" is
generous. Every one of them could create a row and archive it, and nothing else. Nine of a provider's
fields, eleven of a service's and eight of a location's had no path to them from the browser at all. A
clinic could be set up once and then never corrected.

Two of the screens were worse than incomplete: they destroyed data on every save. Both
`PUT /v1/providers/:id/services` and `PUT /v1/providers/:id/working-hours` replace a whole set, and both
editors built their request body from a partial read — ids in one case, three of seven fields in the other.
The API was never wrong. The browser was, and the browser had no tests, so 38 green suites said nothing
about it.

This slice finishes the two epics rather than extending them. Almost nothing here is a new capability on the
server: `customDurationMinutes`, `locationId` on a working-hours row, `PATCH /v1/availability-exceptions/:id`
and the `includeArchived` filter were all built in Epics 2 and 3 and had simply never been reachable. The
exceptions are §2.2's restore routes and §2.3's one-line repair, both of which exist because archiving turned
out to be a trapdoor.

---

# 2. The central decision: a whole-set body may only be built from a whole-set read

Four endpoints in this system replace a set rather than patching one: provider services, provider locations,
working hours, service translations. Each deletes what the body omits. That is the right shape — it matches
what a checkbox list expresses, it is idempotent under a double submit, and it cannot leave half-applied
state when a browser gives up mid-request (phase-2 §3.5).

It is also unforgiving in a way that is invisible at the call site. `ids.map((serviceId) => ({ serviceId }))`
reads like an obviously correct translation of "these are the ticked boxes". It is, and it still cost every
per-provider duration override, every per-provider price and every paused assignment, on every save, for as
long as the screen existed.

The fix is structural, not remembered. The body builders moved into `apps/web/src/lib/assignments.ts` and
`working-hours.ts` as pure functions that take the **loaded rows** and nothing else. There is no id-only
overload to reach for, the seeding functions are the only way to obtain rows, and the submit button stays
disabled until every contributing query reports `isSuccess`. Being pure, both are unit-tested without a DOM —
which is where the original defect would have been caught in a morning.

|                    | Before                                             | After                                      |
| ------------------ | -------------------------------------------------- | ------------------------------------------ |
| Assignment body    | `{ serviceId }` per ticked box                     | every field the GET returned               |
| Seeded from        | `assigned.filter((r) => r.active)`                 | existence, with `active` edited separately |
| Rendered           | immediately, `defaultChecked` from a pending query | only once all four queries resolve         |
| Working-hours body | `{ weekday, startTime, endTime }`                  | all seven fields                           |

## 2.1 Three defects, one shape change

The assignment panel had three separate bugs that all dissolved into the same rewrite, which is the clearest
evidence that the shape was the problem rather than any individual line.

1. **The lossy body**, above.
2. **The not-yet-loaded wipe.** The checkboxes were uncontrolled, seeded with `defaultChecked` from a query
   that had not resolved on first render. Every box painted unticked, and `defaultChecked` never re-syncs.
   Opening the panel and pressing Save quickly unassigned everything the provider offered.
3. **The paused-assignment deletion.** The seed filtered on `item.active`, so an assignment that existed but
   was switched off rendered unticked and was deleted by the next save. "Does this provider offer X" and "are
   they offering it right now" are different questions, and the editor was asking one to answer both.

### The empty set is not the empty state

Worth its own note, because the first version of _this_ slice reintroduced defect 2 in a quieter form. Both
whole-set editors seed from an effect, and both initialised their state to an empty container — `new Map()`
for assignments, `{}` for the week. But an empty set is a **valid, meaningful value**: "offers nothing",
"never working". It therefore cannot also stand for "not loaded yet", and there is a real paint between a
query resolving and the effect that seeds from it, during which Save would have submitted it and deleted
everything.

Both now hold `null` until seeded and render a placeholder instead of a form. Seeded rows — not
`query.isSuccess` — are the readiness signal, because the rows are what the body is built from and anything
else leaves a gap between the two.

## 2.2 Restore is a route, not a PATCH field

Archiving was one-way. There was no restore endpoint anywhere in the catalogue API, and because
`@@unique([tenantId, slug])` carries no `WHERE archived_at IS NULL` predicate, an archived service reserves
its slug for as long as the row exists. So a misclick did not merely hide a service — it permanently blocked
recreating one by that name, and the error the owner saw was `SLUG_TAKEN` for a service they could not see.

The cheaper option was `archivedAt: z.null()` on the three update schemas. It was rejected for the reason
`provider.schemas.ts` already gives about the other direction:

> `archivedAt` is not here — archiving goes through DELETE, so that it is one auditable action rather than a
> field anyone can toggle.

A PATCH field would also let this slice's own edit forms un-archive by accident while round-tripping what
they read, and would record a lifecycle change as `service.updated`, indistinguishable from a price edit.
`POST /v1/tenants/:id/activate` is the existing precedent for a verb as a subresource.

**Restore clears `archivedAt` and leaves `active` false.** `DELETE` sets both, so the symmetric inverse would
set both back — but rule 11 is that these are two different questions, and restore only answers the first.
The public predicate is `active && archivedAt === null`, so a restore that also activated would put a service
back in front of strangers in one click. Reactivating stays a second, deliberate press.

**Restore performs no slug check, and needs none.** The unique index covers archived rows, so nothing can
have taken the slug while it was away. The comment in `service.repository.ts` says so explicitly, because
the next reader's instinct will be to add one — and notes the dependency: if that index ever becomes partial,
restore acquires a failure mode.

## 2.3 An archived service could not be kept assigned

`ProviderService.setServices` deleted every assignment whose id was absent from the submitted set, while
`assertServicesExist` rejected ids belonging to archived services. Those two rules together left the client
with no correct move: omit an archived service's id and its assignment is destroyed, include it and the
request 404s. Archiving a service therefore silently severed every provider's link to it on their next save,
and restoring the service did not bring them back.

Both delete sweeps now exclude archived counterparts. An archived service is not in the picker, so its
absence from the body is an artefact of the editor's own filter rather than a statement by the user.
Everywhere else in this codebase an archived row simply does not participate; this makes assignments agree,
and is what lets §2.2's restore actually restore.

## 2.4 The link the technical spec forgot: a service belongs to locations

> **Reversed on 2026-08-03, the same day, before release. See §2.7.** Everything below is left as written
> because it is the argument the reversal answers, and because the empty-set convention it establishes still
> governs `WorkingHours.locationId` and `AvailabilityException`. The table, its two endpoints, the service
> detail's `locations` array and the slot-search predicate are gone.

PRD.md specifies this on both sides — §9.4, "the service may be assigned to … one or more locations", and
§9.5, which lists "supported services" among a location's fields. technical-implementation.md §10 never
modelled it: it defines `locations` (§10.7) and `provider_locations` (§10.8) and nothing joining services to
locations. Epic 2 built what the technical spec said, and so nothing in the system could express _whitening
is only done at the Buda surgery_. Slot search would happily offer a service at a site with no equipment for
it, because the only location constraint it knew was which sites the **provider** works at.

Both links are real and neither replaces the other. A booking needs the intersection:

| Constraint                         | Table                | Question                             |
| ---------------------------------- | -------------------- | ------------------------------------ |
| Dr. Kovács works at Buda only      | `provider_locations` | where does this _person_ work?       |
| Whitening is done at Buda and Pest | `service_locations`  | where is this _procedure_ available? |

Migration `20260803114233_service_locations`. Written from the location side only
(`PUT /v1/locations/:locationId/services`) and read back from the service side on
`GET /v1/services/:serviceId`, for the reason §3.1 already refuses a second writer over
`provider_services`: two whole-set writers over one join table clobber each other with no version column to
notice.

### An empty set means _everywhere_

The decision the whole thing turns on. A service with no rows is offered at **every** location, not at none.

The alternative — explicit opt-in, nothing bookable until assigned — is stricter and was rejected on two
grounds. It would have made every existing service unbookable the moment the table shipped, needing a
backfill of every service against every location. And it contradicts the convention this schema already
uses for an unset scope: `WorkingHours.locationId` NULL means "wherever this provider works", and an
`AvailabilityException` with a null `locationId` or `serviceId` applies to everything. One rule, already
learned.

The cost is that the checkbox list reads backwards — nothing ticked looks like "nothing offered here" when
it means the opposite — so the panel says so in as many words rather than leaving it to be inferred. The
enforcement lives in one place, `availability.service.ts`, which asks the question only once a restriction
exists.

## 2.5 Exceptions convert; schedules do not

`<input type="datetime-local">` yields a reading with no zone, and `new Date(value)` resolves it in the
browser's. An administrator in London closing a Budapest diary for 09:00 was storing 10:00 local.

`apps/web` now depends on `@bam/availability-engine` and converts through `resolveWallClock`. Rule 13 requires
it in as many words, and the reason is on the record: the engine's own predecessor assumed every DST
transition was an hour and returned the wrong instant for Lord Howe Island's 30-minute shift while reporting
it as `exact` (phase-3 §2.2.1). The engine also gives us something a hand-rolled conversion cannot — it says
whether a reading was _skipped_ or _ambiguous_, so the form warns before the user commits rather than
silently snapping a closure an hour away from where they typed it.

Sending wall-clock plus zone to the API and converting server-side was rejected: it would turn
`createExceptionBodySchema.startAt` into a union on a route that Epics 6–8 will call with genuine instants,
and the server would still have to report the resolution back for the UI to warn, making the round trip
longer rather than shorter.

The working-hours editor deliberately does **not** convert. A schedule is wall-clock (rule 13, tech-impl
§13.4): "Mondays 09:00–17:00" must still read 09:00–17:00 on the Monday the clocks change. The provider's
zone is named in the hint and applied to nothing, and both files carry a comment saying so, because the
asymmetry looks like an oversight to anyone who fixes one half without reading the other.

## 2.6 A provider is created with what they offer and where they are based

The first owner to use these screens could not get past the provider form. Not because it was broken — a
provider needs only a name — but because it asked for nine attributes and nothing about _what this person
does_, and the answer to that lived behind an **Assign** button on a table row that does not exist until
after you have pressed Create. The one control that mattered was unreachable at exactly the moment it
mattered. §3.3 had already noted that the linking step was invisible and answered it with a line of text
under the table; a hint is not a control.

The create panel now carries both pickers. They are deliberately not the same shape:

|          | Control                            | Why                                                                                                                  |
| -------- | ---------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Services | checkbox list, many                | A provider offers a set. Without at least one they cannot be booked at all, so this is the form's real subject       |
| Location | select, exactly one, blank allowed | Where this provider is _based_. Not a set: the set is what they may work at, which is a later and different question |

Assign keeps everything else — additional locations, per-provider duration and price, pausing an assignment.
Those are answers about a provider who already exists.

Blank is a real answer to the location, not a skipped field: slot search never requires a location, so an
online-only or telephone practice has no base to name. And a provider created with no service ticked is
valid too — it is the state the screen used to force on everyone.

Three requests, not one, because `POST /v1/providers` accepts neither set. That cannot be a transaction, so
a failure after the first request leaves a provider with nothing attached. Rather than report the generic
error — which would have an owner press Create again and produce a duplicate — the panel says the provider
exists and names Assign as the way to finish.

## 2.7 Reversed: `service_locations` is gone

§2.4 added a service↔location link. It is removed, on the owner's judgement, one migration later
(`20260803181500_remove_service_locations`).

**A location is one of the organization's sites and nothing more.** Whether a service is offered somewhere
is not an independent fact to be maintained: it follows from whether a provider who offers that service
works there, and _that_ is stated by the provider when they set their availability — a `working_hours` row
already names both a location and, through `provider_services`, what is on offer during it. The link was a
second, weaker answer to a question something else already answers, and the two could disagree with nothing
to reconcile them.

This is a deliberate deviation from PRD §9.4/§9.5, which specify the link on both sides. Recorded as such in
§5.5. What the PRD is reaching for is still expressible — a service confined to one site is a provider who
offers it working only there — but it is now said in one place rather than two.

What went with it: the table, `PUT`/`GET /v1/locations/:locationId/services`, the `locations` array on
`GET /v1/services/:serviceId`, the "Services here" panel, the service form's read-only "Offered at" block,
`seedLocationServiceRows`/`buildLocationServicesBody` and six message keys per locale. The slot-search
predicate in `availability.service.ts` is deleted rather than defaulted: there is no restriction to consult.

### Who decides what, after this

Worth stating plainly, because it is the line the whole screen set is organised around and it was not
written down before:

| Decision                                                       | Whose            | Where        |
| -------------------------------------------------------------- | ---------------- | ------------ |
| Which services exist, at what price, for how long              | owner            | Services     |
| Which sites the organization has                               | owner            | Locations    |
| Who the providers are, what they offer, where they are based   | owner            | Providers    |
| **When each provider works, at which site, for which service** | **the provider** | Availability |

Availability is not the owner's to fill in, which is why the owner's form stops at a _default_ location. How
a provider might later delegate that — a receptionist managing a diary — is not built and not designed; it
is named here only so the next person does not read the current absence as a decision.

## 2.8 A provider must be reachable

`email` was optional on a provider and is now required — on create, and not nullable on update, so it can be
corrected but never cleared. `Provider.email` in the database stays `String?` (see §5.10); the constraint is
at the API, which is what stops any _new_ null appearing.

The reason it was optional is on the record and was not wrong: a provider is a **diary**, not a login. The
front desk can keep a visiting hygienist's schedule without that person ever having an account, which is why
`Membership.providerId` is nullable in both directions. None of that changed.

What did change is what the address is _for_. It is not a credential and it signs nobody in. It is the only
route to the person behind the diary, and three things need one: the invitation that would give them a login,
every notification about their own bookings (Epic 5), and the owner needing to reach them at all. A diary
nobody can be told about is not a useful diary.

### No, creating a provider sends nothing

Worth stating because it is the obvious assumption and it is wrong. `POST /v1/providers` writes one
catalogue row. It creates no user, no membership, no invitation, and sends no email — there is no
"set your password" message, because there is no account to set a password for.

Giving a provider a login is still two separate steps, neither of them on this screen: invite the person
(`POST /v1/members/invitations`), then link the membership that results to the diary
(`PATCH /v1/members/:membershipId` with `providerId`). §5.11 records that the Providers screen offers no path
to either, which is now a more visible gap than it was, because the form collects exactly the address the
invitation would go to.

**Corrected 2026-08-04.** This paragraph named two routes that do not exist — the prefix is `/v1/members`,
not `/v1/tenants/:id` or `/v1/memberships` — and said the invite "does send an email", which was not true of
any invitation at the time: phase-1 §5.1 is explicit that the link was returned once in the response and
never delivered. Both are fixed above. The step it describes is itself now superseded: see
[phase-9-provider-onboarding.md](phase-9-provider-onboarding.md), where one row action does both and the
email is real.

## 2.9 Availability belongs to a provider, so that is where the link is

The dashboard nav had **Availability** as a seventh top-level item, beside Services, Locations and Providers.
That framing is wrong in the same way §2.4 was: it presents a provider's working week as one more thing the
organization configures, when it is the one part of this system that is _theirs_.

- The top-level item is gone for administrators. Each provider's row now carries an **Availability** link
  (`?providerId=`), so an owner opens one named diary at a time rather than a screen that silently defaults
  to whichever provider sorts first.
- A member whose membership names a provider still gets the nav item, pointing at their own diary. Removing
  it outright would have left a provider with no route to their own schedule at all — the Providers screen is
  not necessarily theirs to see.

The query parameter seeds the picker and nothing more. An administrator can still switch diaries without
navigating, and the API has not moved an inch: `availability:manage:own` versus `:all` decides, server-side,
on every request, so a provider who edits the URL gets a 403 rather than somebody else's week.

---

# 3. Delivered

## 3.1 Endpoints

```http
POST   /v1/providers/:providerId/restore    # 200 provider; clears archivedAt, leaves active false
POST   /v1/services/:serviceId/restore      # 200 service; idempotent, audits only a real restore
POST   /v1/locations/:locationId/restore    # 200 location
```

Each restore route takes `requireWritableTenant` plus the same `*_MANAGE` permission as the `DELETE` it
undoes, and emits `provider.restored` / `service.restored` / `location.restored` carrying both `before` and
`after`. Restoring a row that is not archived returns it unchanged and writes no audit event — an audit trail
of no-ops buries the real one.

Two migrations, and the second undoes the first: `20260803114233_service_locations` added the table §2.4
argues for, `20260803181500_remove_service_locations` drops it again (§2.7). The pair is left in history
rather than collapsed, because the first was applied to a real database before the reversal and
`pnpm db:drift-check` in §6 asserts that the committed migrations reproduce the schema.

The one behavioural repair outside those routes is §2.3's two `where` clauses in
`apps/api/src/modules/providers/provider.service.ts`.

### What was deliberately not added

**No `PUT /v1/services/:id/providers`.** A service's providers are written from the Providers screen and
read back on the service detail. Two whole-set writers over one join table would clobber each other with no
version column to notice. Read from both sides, write from one.

## 3.2 Pure modules, and why they are separate files

| File                                 | Holds                                              | Tested for                                                             |
| ------------------------------------ | -------------------------------------------------- | ---------------------------------------------------------------------- |
| `apps/web/src/lib/assignments.ts`    | seeding and body-building for both assignment sets | overrides and paused rows survive a save; unticking still removes      |
| `apps/web/src/lib/working-hours.ts`  | the week, grouped and flattened                    | all seven fields round-trip; `24:00` survives; times are not converted |
| `apps/web/src/lib/exception-time.ts` | `datetime-local` ↔ instant, in the provider's zone | Budapest spring-forward and fall-back; Lord Howe's 30-minute shift     |
| `apps/web/src/lib/catalogue-form.ts` | the create/patch asymmetry, `diffPatch`, zone list | blank omitted on create and null on patch; zero ≠ blank                |

These are separate from the components because they are the parts that were wrong, and a component test would
have needed jsdom, testing-library, a `QueryClientProvider` wrapper and an `apiFetch` mock before it could
assert anything. `apps/web` had a vitest config with `passWithNoTests: true` and no specs; it now has 33.

### Why an empty text box is two different values

`create*BodySchema` is built from `.optional()`: an absent key takes the server's default, and there is no
`null` — `email: null` fails validation outright. `update*BodySchema` is `.partial()` over `.nullable()`: an
absent key means "leave alone" and an explicit `null` means "clear it", so omitting a field can never empty
one. `textValue(mode, value)` is the single place that decides, and it never emits `""` — `JSON.stringify`
drops `undefined` but transmits the empty string, which `z.email()`, `slugSchema` and `timezoneSchema` all
reject. Each create panel used to dodge this by hand.

### Why PATCH sends a diff

Catalogue rows carry no `version` column, unlike `Booking`. A full-body PATCH is therefore a blind overwrite
of anything a colleague changed since the panel opened. `diffPatch` narrows last-writer-wins from the whole
row to the fields this user actually touched. Not a guarantee, but a fifteen-line improvement on the
alternative, and §5.4 records the residue.

## 3.3 Web

| Screen       | Now does                                                                                                                                                                                                                                                                |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Providers    | edit all nine previously unreachable fields; a required email (§2.8); services and a default location picked **at creation** (§2.6); a link to each provider's own diary (§2.9); assignments with per-service duration and price overrides; archived filter and restore |
| Services     | edit all eleven; slug, buffers, approval, booking window; "offered by", read-only; `SLUG_TAKEN` explained                                                                                                                                                               |
| Locations    | edit type, both address lines, country, timezone, coordinates; archived filter and restore                                                                                                                                                                              |
| Availability | working hours with location scope, validity dates, `24:00`; exceptions created **and edited**, scoped to a location or service, in the provider's zone, with a range filter                                                                                             |

`availability-screen.tsx` split into itself plus `working-hours-editor.tsx` and `availability-exceptions.tsx`
— three components that shared only a `providerId`. The catalogue screens stayed single-file, each gaining a
`*-fields.tsx` sibling used by **both** its create and its edit panel. That sharing is the actual fix for the
unreachable-field problem: create and edit were going to be different code, and edit was never written.

### The order the catalogue has to be built in

The nav listed Providers before Services, which is the order the epics were written in and the opposite of
the order the work has to be done in. A provider is booked _for a service_: created first, they have nothing
to offer, cannot appear on the booking page, and the screen gives no hint why. The catalogue items now run
**Services → Locations → Providers → Availability**, which is the dependency order. Bookings stays first
among the gated items, unchanged — the catalogue is configured once and the diary is read every day.

The dependency is not symmetric, and the screens now say so rather than treating the two alike:

|            | Required?                                                                                                         | What the screen says                              |
| ---------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| A service  | **Yes.** Slot search needs an active `provider_services` row; without one the provider is unbookable              | an amber notice on Providers, linking to Services |
| A location | **No.** `locationId` is optional throughout slot search, so an online or telephone practice is bookable with none | a plain informational notice saying exactly that  |

Two further gaps closed at the same time, both found by an owner rather than by a test:

- **The linking step was invisible.** Assigning services to a provider is a row action among four, and an
  owner who had created both services and providers had no way to discover what joined them. The Providers
  screen now names it in a line under the table.
- **Availability could be filled in for nothing.** Setting a week of hours on a provider who offers no
  service produces no bookable slot, and the screen looked complete. It now warns, at the last point the
  owner passes through before expecting bookings.

### The linking step was still a second step — 2026-08-03

Naming the row action under the table was not enough. An owner with one service created and no provider yet
read "Add a provider", found no way on that form to say _what they provide_, and stopped — reporting the
missing control rather than the missing provider. The row action cannot help before the row exists, which is
exactly the moment the dependency matters.

`CreateProviderPanel` now carries a service checkbox list, and creates in two requests: `POST /v1/providers`
then `PUT /v1/providers/:id/services`. Three things about that shape:

- **It is not the Assign panel moved.** Only membership is offered here. Per-provider duration, price and
  pausing stay behind Assign — they are answers about a provider who already offers the service, and putting
  them on a create form makes the common case longer to serve the rare one.
- **No whole-set read is skipped.** §2's rule is that a whole-set body may only be built from a whole-set
  read of that same set; for a provider that does not exist yet the set is empty by construction, so the rows
  are seeded unticked and the body still goes through `buildProviderServicesBody`. A refetch of the service
  list merges into the existing rows rather than replacing them, so a background refresh cannot untick a
  form mid-fill.
- **The second request can fail on its own.** `POST /v1/providers` takes no services, so this cannot be one
  transaction. A failed `PUT` therefore reports `createdButNotAssigned` — the provider exists, finish with
  Assign — rather than the generic error, which would have the owner create a duplicate.

### `24:00`

`endTimeSchema` accepts it, the CHECK constraint allows it, and `availability.test.ts:264` covers it — but
`<input type="time">` cannot represent it, because HTML's valid time string stops at 23:59. A provider whose
shift ended at midnight had an unsavable week: the input rendered blank and submitted `""`, which 422s. There
is now a "to midnight" checkbox that sets the value and disables the input.

### Focus, which inline panels do not get for free

There is no Dialog primitive here and there is not going to be one; editing is an inline `Panel` toggled by
state. What that pattern loses is everything a dialog does about focus — before this slice, pressing "Assign"
rendered a panel below the fold and left the caret on the button, so for a keyboard or screen-reader user
_nothing observable happened_. `useEditPanel` in `dashboard-shell.tsx` gives the trigger `aria-expanded` and
`aria-controls`, focuses the panel on open, and returns focus to the trigger on close. All four screens get it
uniformly.

## 3.4 Localization

67 new keys in the `catalogue` and `availability` namespaces, in both `messages/en.json` and
`messages/hu.json` — 375 each, verified equal. Hungarian was written first: it is the unprefixed default
locale, so a missing `hu` key is what the pilot tenant sees. One key was a rewrite rather than an addition —
`catalogue.addServiceHint` promised that buffers were "configured per service later", which the create form
made false.

---

# 4. Safeguards worth naming

| Risk                                                              | Safeguard                                                                                | Test                                                                                                                                   |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| A whole-set body built from a partial read                        | builders take loaded rows as a required argument; Save disabled until `isSuccess`        | "carries a per-provider duration and price through a save"                                                                             |
| A paused assignment read as an unticked one                       | `checked` seeded from existence, `active` edited separately                              | "keeps a paused assignment ticked, and paused"                                                                                         |
| The guard turning `PUT` into append-only                          | unticking a live service still removes it, both sides                                    | "omits an unassigned service, so unticking still removes it"; "still removes a live service dropped from the set"                      |
| Archiving severing assignments                                    | delete sweeps exclude archived counterparts, on all three join tables                    | "leaves an archived service's assignment alone when the set omits it"; "leaves an archived service's link alone when the set omits it" |
| Removing `service_locations` making a named location mean nothing | a location narrows to where the provider actually works, and that is asserted both ways  | "offers a service at a location nobody has said anything about"; "returns nothing at a location the provider does not work at"         |
| A provider created with nothing attached, again                   | the create form carries both pickers, and a failed link says the provider already exists | §6.2 step 1a (manual)                                                                                                                  |
| A provider nobody can reach, or an address silently cleared       | required on create, non-nullable on update                                               | "refuses a provider with no email, and one that cannot be reached"; "refuses to clear a provider's email, while allowing a correction" |
| An accidental archive blocking a name forever                     | restore, plus a hint on the `SLUG_TAKEN` error                                           | "keeps the slug reserved while archived, and restore is how you get it back"                                                           |
| Restore quietly republishing to customers                         | `active` stays false                                                                     | "brings a service back inactive, not straight onto the booking page"                                                                   |
| A closure landing an hour from where it was typed                 | `resolveWallClock`, and a `role="status"` warning before submit                          | "reports a reading the clocks jumped over, and snaps forward"                                                                          |
| A DST assumption that only holds for whole hours                  | conversion goes through the engine                                                       | "handles a half-hour DST shift, not just a whole-hour one"                                                                             |
| `validFrom` sent as a Date landing a day out                      | date-only strings all the way to the wire                                                | "round-trips every field the API returned"                                                                                             |
| A price misread by two orders of magnitude                        | `fromMinorUnits` / `toMinorUnits`, never `/100`                                          | "reads a blank box as inherit, not as zero" (and the HUF fixtures throughout)                                                          |

---

# 5. Deviations and known gaps

1. **Cursor pagination is still not wired up.** Every list requests `?limit=100` and ignores `nextCursor`.
   `useInfiniteQuery` plus a "Load more" button is the intended shape and the API has supported it since
   phase-2 §3.3; it was deferred deliberately as a scale problem no current tenant has. The pickers inside the
   assignment panel should stay capped regardless — infinite scroll inside a checkbox list is worse than the
   problem it solves.
2. **No component tests.** `apps/web` now tests its pure logic — the four modules in §3.2 — but nothing
   renders. Standing up jsdom, testing-library and a provider wrapper is its own piece of work, and Playwright
   owns the end-to-end paths per technical-implementation.md §39.6. Worth stating plainly: the data loss this
   slice fixed needed no new API coverage, because the API was always correct. The 38 existing suites could
   not have caught it.
3. **Assignments are still written from the provider side only.** §3.1 explains the refusal. If a service→
   providers writer is ever wanted, the two endpoints need a shared version column first.
4. **Two admins editing one catalogue row is last-writer-wins.** `diffPatch` reduces the blast radius to the
   fields each touched, but there is no `version` column on `providers`, `services` or `locations` and no
   409 to be had. Adding one is a migration and a contract change; it has not been needed yet.
5. **Still no calendar view.** The availability screen remains a form (phase-3 §5.7). Epic 6.
6. **`GET /v1/providers/:id/availability-exceptions` still reads `from`/`to` as UTC day boundaries**, not the
   provider's. The range filter now makes the window explicit, which mostly hides it, but a query for a single
   day at the edge of a large offset can still be off by one.
7. **A flake in `billing.test.ts`, pre-existing and not from this slice.** "sends an English organization back
   to its English screen after paying" intermittently fails at `accept-and-register` with a 404 during full-
   suite runs — roughly one run in three, on a clean checkout of `main` as well as with these changes
   (verified by stashing). It is the same class of cross-suite interference `catalogue.test.ts:25-37`
   documents. Not diagnosed here; it deserves its own look.

8. **PRD §9.4/§9.5's service↔location link is not built, and will not be.** §2.7 records the reasoning and
   the reversal. A service confined to one site is expressed as a provider who offers it working only there.
   The PRD text should be amended rather than left to look like an outstanding gap.
9. **Delegating a provider's availability is neither built nor designed.** Availability is the provider's to
   set (§2.7); a receptionist or an owner managing someone else's diary on their behalf is a real requirement
   that has no model yet — the current API authorises by `PROVIDER_MANAGE` and membership, with no notion of
   acting _for_ another provider. Named so the absence reads as pending rather than decided.

10. **`Provider.email` is still a nullable column.** Both write schemas require it (§2.8), so no new null can
    appear, but rows created before today may hold one and the response schema stays nullable to serialize
    them. Tightening it to `NOT NULL` is a migration that needs every existing provider to have an address
    first — a backfill nobody can perform automatically, since the value has to be correct rather than merely
    present.

    **Since 2026-08-04** that nullability has a user-visible consequence rather than only a theoretical one:
    the Invite action refuses a provider with no address and the button renders disabled, so a legacy row is
    a person who cannot be given a login until somebody types their email. The backfill now has a reason.

11. ~~**The Providers screen cannot give a provider a login.**~~ **Closed 2026-08-04** by
    [phase-9-provider-onboarding.md](phase-9-provider-onboarding.md). It is one row action, not two screens:
    `POST /v1/providers/:providerId/invitation` issues an invitation carrying the diary, emails it, and
    acceptance links the membership in the same transaction that burns the token. There is no second step to
    forget, which was the actual defect — the API had supported `PATCH /v1/members/:id { providerId }` since
    Epic 2 and nothing ever called it.

The following are now **closed** and should be struck from their own records:
phase-2 §5.4 (per-provider overrides unreachable from the dashboard) and phase-3 §5.6 (`datetime-local` in
the browser's zone rather than the provider's).

---

# 6. Verification

```bash
pnpm lint && pnpm check-types && pnpm test
pnpm db:drift-check
```

## 6.1 Results — 2026-08-03

| Suite                          | Result                                                                                                                                                                                                 |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm lint`                    | 19 tasks, all pass                                                                                                                                                                                     |
| `pnpm check-types`             | 19 tasks, all pass                                                                                                                                                                                     |
| `apps/api`                     | 225 pass (was 209 — nine for restore and assignments, three for §6.1's tenant-resolution bug, two for §2.7's location question, two for §2.8's mandatory email; six §2.4 cases removed with the table) |
| `apps/web`                     | 33 pass (was 0, `passWithNoTests`; three §2.4 cases removed with the table)                                                                                                                            |
| `pnpm --filter @bam/web build` | compiles; 29 static pages                                                                                                                                                                              |
| `pnpm db:drift-check`          | no drift — the committed migrations reproduce the schema                                                                                                                                               |

Message-key parity was checked directly rather than assumed: 385 keys in each locale, no key present in one
file and absent from the other. next-intl throws on a miss, so an unequal pair is a crash on the screen that
uses it.

### The bug that made all of this invisible to the first real owner

Found by an owner signing in, not by the suite. Every screen this slice built rendered, and every "New"
button was missing — services and providers both said "none yet", and availability said the account was not
linked to a provider. It read as a permissions problem, and it was not: the membership was `OWNER` / `ACTIVE`
against a `TRIAL` tenant, exactly right.

`Session.activeTenantId` is written by exactly two things: `POST /v1/tenants` and
`POST /v1/tenants/:id/activate`. An owner who arrives by invitation — which is how _every_ sales-led
subscriber arrives — passes through neither. And the dashboard's tenant switcher, the only caller of
`activate`, renders only when there are two or more tenants to switch between. So a single-tenant invited
owner had no path to setting it, ever.

`/v1/me` is fetched without the `X-Tenant-Id` header, so it fell through to that null, and its handler's
`catch` reported `permissions: []` — a legitimate answer for a user with no tenants, and a silent lie here.
The screens still rendered because `useDashboardContext` takes its tenant id from `GET /v1/tenants` when
`/v1/me` has none, so the two disagreed: the lists queried the right tenant while every `can()` returned
false.

`resolveTenantId` now has a third step — the caller's sole ACTIVE membership. That is not a client hint and
not a guess; it is the membership table answering a question with one possible answer. Two or more stays
ambiguous and is refused, which is also exactly when the switcher appears and can settle it, and an `INVITED`
membership is never selected. It fixes sessions that are already null, without anyone signing in again.

Why no test caught it: every API test sends `x-tenant-id` explicitly, and the Epic 9 manual walk ends at
activation without opening a catalogue screen. Three cases were added to `tenancy.test.ts` — the sole
membership, the ambiguous pair, and the invitation-only membership.

### The bug the plan did not predict

The reported defect was the lossy assignment body. Reading the file to fix it turned up a second, worse one
in the same twenty lines: the checkboxes were uncontrolled and seeded from a query that had not resolved, so
opening the panel and saving immediately unassigned everything — no editing required, no override needed to
lose anything. And a third: the seed filtered on `active`, deleting paused assignments. All three were
consequences of building a whole-set body from something other than a whole-set read, which is why §2 leads
with the rule rather than the symptom.

## 6.2 Live end-to-end, against the running API

**Not yet performed.** `pnpm dev` must be restarted rather than hot-reloaded before this walk: `apps/web`
gained `@bam/availability-engine`, libraries resolve to `dist/`, and a stale build reports
`Export X doesn't exist in target module` with a misleading suggestion.

1. Create two services; assign both to a provider; set a custom duration on one; save. Reopen — the override
   is still there.
   1a. Create a provider with one of those services ticked on the create form itself. Assign shows it already
   ticked, and a slot search returns times without a second visit to that panel. Repeat with none ticked —
   the provider is created and offers nothing, which is a valid state, not an error.
2. Reopen and press Save _immediately_, before the lists paint. Nothing is unassigned.
3. Archive one service; save the provider's assignments again; restore the service. The provider still offers
   it.
4. Create a service with the archived one's name → `SLUG_TAKEN` with the hint. Tick "Show archived", Restore,
   confirm it returns **inactive**, then activate it.
5. Edit a service: name, slug, buffers, `requiresApproval`, a HUF price. The list shows `15 000 Ft`, not
   `150 Ft`.
6. Edit a provider: languages, timezone, `onlineBookingEnabled` off, a minimum notice. Clear the notice and
   confirm it reads as inherited rather than zero. Clear the **email** and confirm the form refuses to save.
   6a. As an owner, confirm there is no Availability item in the nav, and that the link on a provider's row opens
   _that_ provider's diary (§2.9). Signed in as a member linked to a diary, confirm the nav item is back and
   opens their own.
7. Scope a working-hours period to a second location; add one ending at midnight via the checkbox. Save,
   reload — location, validity window and `24:00` all survive.
   7a. Search for slots naming the provider's location — times come back. Search naming a _second_ location the
   provider has no hours at — nothing, while the same search without a location still returns times. There is
   no service↔location link to configure any more (§2.7); if a "Services here" button is still on screen, the
   dev server is serving a stale build.
8. Set the OS timezone to `America/New_York` and add an exception. The stored instant is right in the
   provider's zone, and the list renders it in the provider's zone. Then pick 02:30 on a spring-forward date
   and confirm the warning appears _before_ submit.
9. As a PROVIDER-role member linked to a diary: no picker, own diary only, and exception times still in the
   provider's zone.
10. As an ASSISTANT: no Edit or Restore controls, and the endpoints still 403 when called directly.
11. Keyboard only: tab to Edit, press Enter, focus lands in the panel and returns to the button on Cancel.
12. `/en/dashboard/...` and back: no raw message keys in either locale.

---

# 7. Next

Epics 2 and 3 are now complete on both sides of the wire. What is left in `docs/phase-9-manual-test-checklist.md`
is still unwalked, and this slice adds a second walk to it (§6.2). Epic 6 inherits three things named above:
the calendar view, the `externalBusyPeriods` that calendar sync will finally populate, and the map that
`latitude`/`longitude` have been carrying since Epic 2 without a reader.
