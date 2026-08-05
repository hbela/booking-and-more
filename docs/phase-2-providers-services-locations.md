This is the execution record for the third delivery phase, derived from PRD.md §9.4 and technical-implementation.md §44 (Epic 2).

# Phase 2 — Providers, Services and Locations

## Implementation Record

**Document version:** 1.0
**Scope:** Epic 2 — provider, service and location CRUD; provider↔service and provider↔location assignment; the public booking catalogue; dashboard screens; localization fields
**Depends on:** [phase-1-authentication-and-tenancy.md](phase-1-authentication-and-tenancy.md)
**Exit criteria:** An owner can fully configure one clinic · Inactive services and providers cannot be publicly booked

---

# 1. Context

Phase 1 delivered tenancy with nothing in it. A tenant could be created, staffed and audited, but there was
nothing to book — no one to book with, nothing to book them for, nowhere for it to happen.

This phase adds the catalogue: **who** does the work (`Provider`), **what** the work is (`Service`),
**where** it happens (`Location`), and **which combinations are allowed** (`ProviderService`,
`ProviderLocation`). Everything Epic 3's availability engine reads, and everything Epic 4's booking engine
writes against, is defined here.

It also populates `Membership.providerId`, which activates the `:own` permission paths written and tested —
failing closed — in Phase 1.

---

# 2. The central decision: two flags, not one

Every catalogue row carries both `active` and `archivedAt`, and they mean different things:

| Field        | Meaning                                                                                                  |
| ------------ | -------------------------------------------------------------------------------------------------------- |
| `active`     | Temporarily off. A provider on parental leave, a service only offered in summer. Flipped back.           |
| `archivedAt` | Removed. Hidden from every list and picker, kept so a booking made in March still names what it was for. |

Nothing in the catalogue is ever hard-deleted through the API. `DELETE /v1/providers/:id` archives.

`booking-for-all` deleted services outright and left bookings pointing at rows that no longer existed; every
screen that joined through one then had to cope with a null it was never designed for. The two-flag split is
also what makes the public filter honest: an archived row is not merely absent from a list, it 404s by id.

## 2.1 Nullable means "inherit"

`minimumNoticeMinutes` and `maximumAdvanceDays` appear on both `Provider` and `Service`, nullable on both.
NULL means inherit; the availability engine resolves the pair in Epic 3 by taking the **most restrictive**
value that applies (technical-implementation.md §13.3).

Neither column has a database default, because zero is a real value meaning "bookable up to the last second"
and must stay distinguishable from "not set".

## 2.2 Timezones are resolved at creation, never left null

A provider or location created without a zone inherits the tenant's. The availability engine reads this on
every slot calculation, and a nullable zone there is a null check in the middle of DST arithmetic
(technical-implementation.md §13.4). The cost is one fallback at creation; the alternative is a null check in
the hardest code in the system.

---

# 3. Delivered

## 3.1 Database

Migrations `20260728155410_catalogue_providers_services_locations` and
`20260728160500_membership_provider_link_unique`.

| Table                  | Notes                                                                                          |
| ---------------------- | ---------------------------------------------------------------------------------------------- |
| `providers`            | `languages` as a Postgres text array — read on every public list, never queried in reverse     |
| `services`             | `@@unique([tenantId, slug])`; price as integer minor units plus currency (§10.5)               |
| `service_translations` | `@@unique([serviceId, locale])` — tenant-managed translations (§38)                            |
| `locations`            | `LocationType` enum; lat/long as double precision, so no PostGIS dependency bought for nothing |
| `provider_services`    | `@@unique([providerId, serviceId])`, plus per-provider duration and price overrides            |
| `provider_locations`   | `@@unique([providerId, locationId])`                                                           |

`Membership.providerId` became a real foreign key with `onDelete: SetNull` — archiving a provider must not
delete the person's membership and with it their access.

### Why `tenantId` is denormalised onto the join tables

So every query can be scoped by tenant in one predicate rather than through two joins. Keeping it consistent
with the parents is the service layer's job: both sides are loaded tenant-scoped _before_ the link is
written, and the integration suite asserts that a cross-tenant assignment is refused with nothing persisted.

A composite foreign key (`[tenantId, providerId] → Provider[tenantId, id]`) would have pushed that into the
database, and was considered. It was dropped because `ProviderService` would need to share one `tenantId`
column across two such relations, which Prisma models awkwardly — a database guarantee bought at the price of
a schema nobody can read.

### The hand-written second migration

```sql
CREATE UNIQUE INDEX "memberships_provider_id_key" ON "memberships"("provider_id");
```

At most one login per provider diary. Postgres treats NULLs as distinct in a unique index, so this constrains
only the memberships that actually name a provider. Without it, two accounts could hold `:own` permissions
over the same schedule and neither would know about the other.

Written by hand because `prisma migrate dev` refuses to run non-interactively once it has a warning to show —
here, that adding a unique constraint could fail on existing duplicates. There were none: the column was
introduced nullable in Epic 1 and nothing had ever written to it. `pnpm db:drift-check` confirms the
committed migrations still reproduce `schema.prisma`.

## 3.2 Repositories arrive

Phase 1's modules put Prisma access directly in their service classes. This phase introduces the
`<domain>.repository.ts` layer that technical-implementation.md §6 describes, because CLAUDE.md rule 5 is
much easier to enforce when there is exactly one file per domain that touches the database:

> `tenantId` is a required parameter on every repository call. Never optional, never inferred from ambient
> state.

Every method takes an options object with `tenantId`, and every `where` clause includes it — including the
by-id lookups, so a provider id guessed or leaked from another tenant resolves to nothing.

Writes use Prisma's extended unique filter, `where: { id, tenantId }`: the id makes the row addressable, the
tenant makes it ours. A caller from elsewhere gets `P2025`, which surfaces as the same 404 as an id that
never existed.

## 3.3 Cursor pagination

`apps/api/src/lib/pagination.ts` implements the keyset pagination technical-implementation.md §15.2 calls
for. Two decisions worth stating:

- **Not `OFFSET`.** Catalogue lists are sorted by name, and names change. With `OFFSET`, a rename between two
  page requests shifts every later row, so the client sees an item twice or never at all.
- **Not Prisma's own `cursor` option.** It needs the cursor row to still exist; a row archived between two
  page requests would turn an ordinary list call into an error.

The cursor carries the sort value _and_ the row id, because names are not unique — two providers can both be
"Dr. Kovács", and without the id tiebreak a page boundary landing between them loses rows. A cursor we did
not issue is a 422, not a 500.

## 3.4 The public catalogue

`GET /v1/public/*` is the only part of the API that resolves a tenant from a client-supplied value without
checking a membership, because the whole point is that a stranger can read it. Two things carry the weight
instead.

**The response shapes are separate types**, not the staff ones with a filter applied — so adding a field to
the staff API cannot quietly publish it to the internet. Note what is missing from `publicProviderSchema`: a
provider's email and phone are staff contact details, not booking-page content. There is a test asserting the
seeded address never appears in a public response.

**Every public query carries the same predicate**, in one class:

- the tenant accepts bookings at all (a suspended tenant 404s identically to a slug that never existed),
- the row is `active` and not archived,
- for providers, `onlineBookingEnabled` as well,
- and the two are joined by an assignment that is itself active.

The last one is the easy one to forget. An active service nobody is assigned to is not bookable, and offering
it produces a customer who picks a service and then finds no one to perform it.

## 3.5 Endpoints

```http
GET    /v1/providers                              list (cursor-paginated, by display name)
POST   /v1/providers                              create
GET    /v1/providers/:providerId                  read (archived rows still readable by id)
PATCH  /v1/providers/:providerId                  update
DELETE /v1/providers/:providerId                  archive
GET    /v1/providers/:providerId/services         assigned services
PUT    /v1/providers/:providerId/services         replace the whole set
GET    /v1/providers/:providerId/locations        assigned locations
PUT    /v1/providers/:providerId/locations        replace the whole set

GET    /v1/services                               list (?providerId= filters to one provider's)
POST   /v1/services                               create (slug derived from the name when omitted)
GET    /v1/services/:serviceId                    read, including assigned providers
PATCH  /v1/services/:serviceId                    update
DELETE /v1/services/:serviceId                    archive
PUT    /v1/services/:serviceId/translations       replace the whole set

GET    /v1/locations                              list
POST   /v1/locations                              create
GET    /v1/locations/:locationId                  read
PATCH  /v1/locations/:locationId                  update
DELETE /v1/locations/:locationId                  archive

PATCH  /v1/members/:membershipId                  now also links/unlinks a provider

GET    /v1/public/tenants/:tenantSlug                          branding, policies, languages, locations
GET    /v1/public/tenants/:tenantSlug/services                 bookable services (?locale=, ?providerId=)
GET    /v1/public/tenants/:tenantSlug/services/:serviceId
GET    /v1/public/tenants/:tenantSlug/providers                bookable providers (?serviceId=)
GET    /v1/public/tenants/:tenantSlug/providers/:providerId
```

### Why assignments are `PUT` of a whole set

The dashboard edits them as a checkbox list, so "here is the complete set" is what the user actually
expressed. It is idempotent under a double submit, and it cannot leave a half-applied change if the browser
drops the connection mid-edit. The same reasoning applies to service translations.

## 3.6 Localization

Service names and descriptions are translatable per tenant (technical-implementation.md §38). Fallback is
**per field, not per translation**: a tenant that translated the name but left the description blank gets the
translated name rather than losing both.

The slug, duration and price stay language-neutral, so there is exactly one bookable thing however many
languages describe it. The public tenant endpoint reports which locales it can actually serve — its own, plus
any locale a live service has been translated into.

## 3.7 Web

New screens at `/dashboard/providers`, `/dashboard/services` and `/dashboard/locations`
(technical-implementation.md §28), in Hungarian and English.

The header, tenant switcher and navigation moved into a shared `DashboardShell`. Phase 1 kept the selected
tenant in React state, which was fine with one screen; with four it has to survive a navigation. The switcher
now calls `POST /v1/tenants/:id/activate` and the answer is read back from `/v1/me`, so there is no
client-side idea of "current tenant" that can disagree with the server's. The stored value is still only a
convenience — the API re-resolves membership on every request regardless.

Money crosses the boundary as minor units and becomes a decimal exactly once, using `Intl` to ask how many
decimal places the currency has. HUF has none, so a hard-coded `/ 100` would show a 15 000 Ft cleaning as
150 Ft — and a hard-coded `* 100` on the way in would charge 1.5 million.

## 3.8 Seed

`pnpm db:seed` now configures Sunshine Dental end to end: two providers, two services (one translated into
English, one priced "on request"), a physical surgery and an online consultation room, fully assigned. Enough
that the public catalogue has something to return and Epic 3 has real diaries to compute against. Re-running
is a no-op.

---

# 4. Safeguards worth naming

| Risk                                                   | Safeguard                                                          | Test                                                                                                 |
| ------------------------------------------------------ | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| Cross-tenant read of a provider, service or location   | `tenantId` in every repository `where`; identical 404 either way   | "hides another tenant's provider, service and location behind a 404"                                 |
| Cross-tenant write                                     | Extended unique filter `{ id, tenantId }` → P2025 → 404            | "refuses to update another tenant's provider"                                                        |
| Cross-tenant assignment                                | Both sides verified in-tenant before the transaction opens         | "refuses to assign another tenant's service to my provider"                                          |
| Inactive service publicly bookable                     | Public queries filter `active` and `archivedAt` in one place       | "hides an inactive service"                                                                          |
| Inactive or archived provider publicly bookable        | Same, plus `onlineBookingEnabled`                                  | "hides an inactive provider, and the services only they offered"                                     |
| Service advertised that nobody can perform             | Public queries require a live assignment at both ends              | "hides a service nobody is assigned to"                                                              |
| Staff contact details leaking to the booking page      | Separate, smaller public response schemas                          | "never publishes a provider's contact details"                                                       |
| Suspended tenant still taking bookings                 | `tenantAcceptsWrites` gate on every public read                    | "gives a suspended tenant the same 404 as a slug that never existed"                                 |
| Catalogue reconfigured during suspension               | `requireWritableTenant` before every catalogue write               | "refuses catalogue writes to a suspended tenant while reads still work"                              |
| Assistant or provider reconfiguring the clinic         | `PROVIDER_MANAGE` / `SERVICE_MANAGE` / `LOCATION_MANAGE` per route | "lets an assistant read the catalogue but not change it"                                             |
| Two logins sharing one provider diary                  | Unique index on `memberships.provider_id`                          | "refuses to point two logins at the same diary"                                                      |
| Bookings orphaned by a deleted service                 | Archive-not-delete throughout                                      | "archives rather than deletes"                                                                       |
| Slug collision sending a customer to the wrong service | Per-tenant uniqueness, checked including archived rows             | "refuses a second service with the same slug"                                                        |
| Price stored without a currency                        | Validated across request _and_ stored row, in the service          | "refuses a price without a currency…" / "keeps the stored currency when a PATCH sets only the price" |
| Rows lost or repeated while paging a list being edited | Keyset pagination on (sort value, id)                              | "paginates by cursor, without repeating or losing a row"                                             |

---

# 5. Deviations and known gaps

1. **Working hours and availability exceptions are not here.** `Provider` has a timezone and booking-window
   fields, but no schedule. Both tables belong to the availability engine and land in Epic 3
   (technical-implementation.md §10.9, §10.10).
2. **Web API types are still hand-written.** `apps/web/src/lib/api-client.ts` mirrors the server's shapes by
   hand. Generating them from the OpenAPI document is the right answer and did not make this phase; the
   integration suite is what currently keeps them honest.
3. **No bulk import.** A clinic with forty services types them in one at a time. Fine for the pilot.
4. **Assignment overrides are not editable from the dashboard.** `ProviderService.customDurationMinutes` and
   `customPriceMinor` exist, are honoured by the API, and are covered by tests, but the checkbox UI only sets
   membership of the set. The availability engine will make them visible in Epic 3.

   > **Closed 2026-08-03** by [phase-2-3-owner-management.md](phase-2-3-owner-management.md) §3.3. Both are
   > now edited in a disclosure under each ticked service. Worth knowing: the checkbox UI did not merely fail
   > to *set* them — because the `PUT` replaces a whole set and the body was built from ids alone, it deleted
   > any override on every save. See that record's §2.
5. **Location `latitude`/`longitude` are stored and never used.** They are there for the map on the public
   booking page, which is Epic 6.
6. **Public endpoint rate limits are per-instance** until Redis arrives in Epic 5 — the same gap Phase 1
   recorded, now applying to unauthenticated routes as well, which is where it matters more.

---

# 6. Verification

```bash
pnpm lint && pnpm check-types && pnpm test   # 13/13 tasks, 158 tests
pnpm build
pnpm db:drift-check
pnpm db:seed                                 # twice, to prove idempotence
```

## 6.1 Results — 2026-07-28

| Suite                                          | Result                                  |
| ---------------------------------------------- | --------------------------------------- |
| `@bam/auth` policy units                       | 28 passed                               |
| `@bam/api` (health, tenancy, catalogue, units) | 97 passed                               |
| `@bam/config`                                  | 14 passed                               |
| `@bam/contracts`                               | 9 passed                                |
| `@bam/observability`                           | 5 passed                                |
| `@bam/db`                                      | 5 passed                                |
| **Total**                                      | **157 passed**, 13/13 turbo tasks green |

`@bam/api` grew by 52 tests: 32 integration tests in `catalogue.test.ts` driving both exit criteria through
real HTTP, 19 pure units covering slug derivation, the price/currency pairing and cursor encoding, and one
CORS preflight test described below.

### Two bugs found by using the dashboard, not by the suite

Both were invisible to `fastify.inject()` and to React's test paths, and both predate this phase:

1. **`X-Tenant-Id` was never in the CORS allow-list.** The API read the header and the browser refused to send
   it — every catalogue request failed preflight. `inject()` does not preflight, so nothing caught it through
   all of Epic 1. `app.ts` now names the header from `TENANT_HEADER` rather than spelling it out again, and
   `app.test.ts` asserts that every header the web app sends survives a real preflight. That test fails
   against the old allow-list, which is the only way to know it is worth having.
2. **`router.push()` was called during render** to send a signed-out visitor to sign-in, which React rejects:
   "Cannot update a component while rendering a different component". Phase 1's dashboard had it first and got
   away with it because the redirect only fired on a query error. It is now a `useSignInRedirect` hook that
   navigates from an effect, used by all four staff screens.

### A flake found and fixed, twice

Vitest runs suites in parallel against one database, and both integration files derived their identities from
`Date.now()`. Two files starting in the same millisecond produced the same identifier, so the same label
produced the same email — an intermittent sign-up failure that looked like an auth bug.

Prefixing this suite's identifier fixed that and left the harder half. Teardown matched on
`slug: { contains: RUN }`, and `cat<timestamp>` still _contains_ the bare `<timestamp>` the other suite was
cleaning up by — so `tenancy.test.ts` finishing first would delete this suite's tenants mid-test, and the next
insert failed on `services_tenant_id_fkey`. Roughly one run in three, reported as a 500 from `POST
/v1/services`, which is a long way from the actual cause.

Both suites now use a random identifier and match on `endsWith`, so a suite can only ever delete rows it
created. Confirmed over eight consecutive full runs.

## 6.2 Live end-to-end, against the running API

1. Owner creates a provider, a service and a location, assigns both, links their own membership to the
   provider. `/v1/me` reports the `providerId`. ✓
2. Provider inherits `Europe/Budapest` from the tenant; an explicit `Europe/Vienna` still wins. ✓
3. `Fogkő-eltávolítás` derives the slug `fogko-eltavolitas`. ✓
4. Public catalogue, with no session at all, returns the tenant, one service and one provider — and the
   English translation under `?locale=en`. ✓
5. Deactivate the service: gone from the public list, 404 by id, still visible to staff. ✓
6. Deactivate the provider: gone, and the service goes with them — nobody bookable performs it. ✓
7. Switch `onlineBookingEnabled` off: gone from the public list, still bookable by staff. ✓
8. Outsider names another tenant's provider id: **404 PROVIDER_NOT_FOUND**, byte-identical to a nonexistent
   one. ✓
9. Suspend the tenant: catalogue writes **403**, reads **200**, public page **404** — identical to a slug
   that never existed. ✓
10. Audit trail contains `provider.created`, `provider.services_changed`, `service.created`,
    `location.created`, `membership.provider_linked`. ✓

---

# 7. Next

Epic 3 — the availability engine: working hours, availability exceptions, and the pure slot-generation
package. It reads everything defined here, and per CLAUDE.md rule 8 it stays free of Fastify, Prisma and HTTP
imports so it can be property-tested against daylight-saving transitions.
