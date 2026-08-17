This is the plan for a requirement three phase records have named and none has answered: a provider
hands the running of their diary to somebody else. phase-2-3 §5.9 calls it "neither built nor
designed"; phase-9-provider-onboarding §1.1 says "No delegation" and §7.6 repeats it. The absence was
recorded so it would not read as a decision. This is the decision.

# Phases 3–4 — Diary delegation

## Implementation Record

**Document version:** 1.0 — planned 2026-08-17.
**Scope:** a provider (or an owner or admin) grants a named member the right to manage that provider's
availability, that provider's bookings, or both. One member holds grants from several providers. The
`ASSISTANT` role is narrowed from clinic-wide to delegated-only, and a migration backfills the grants
that keep today's behaviour intact.
**Depends on:** [phase-2-3-owner-management.md](phase-2-3-owner-management.md) §2.7 (availability
belongs to the provider — the line this feature bends, deliberately, and only by the provider's own
act) and §2 (the whole-set `PUT` rule, which this deliberately does *not* invoke) ·
[phase-3-availability-engine.md](phase-3-availability-engine.md) (what is being delegated, half) ·
[phase-4-booking-engine.md](phase-4-booking-engine.md) (the other half) ·
[phase-3-4-schedule-conflicts.md](phase-3-4-schedule-conflicts.md) §2.2 (the affected-bookings payload,
which this feature turns into a scope-crossing leak and then fixes) ·
[phase-9-provider-onboarding.md](phase-9-provider-onboarding.md) §2.9 (the navigation filter, which
would ship this feature invisible if left alone).

---

# 1. Context — what a front desk actually is

`canForProvider` ([policy.ts:95](../packages/auth/src/policy.ts#L95)) offers exactly two answers to
"may this actor touch this diary": you hold the `:all` variant and may touch every diary in the
organization, or you hold `:own` and may touch the one your membership is linked to. There is no third
answer, and a receptionist is the third answer.

The consequence is visible in the `ASSISTANT` row of `ROLE_PERMISSIONS`
([roles.ts:156](../packages/auth/src/roles.ts#L156)): `booking:read:all` and `booking:manage:all`, and
nothing about availability. So the front desk can cancel any appointment in the clinic — including for
providers they have nothing to do with — and cannot move a single working hour for the provider they
work beside every day. Both halves are wrong, in opposite directions, for the same reason: the model
has no way to say *which* diaries.

A grant is also the only shape that makes phase-2-3 §2.7 survive. That record puts availability in the
provider's hands and stops the owner's form at a *default* location precisely so the owner cannot fill
in somebody else's week. Delegation does not reverse that; it is the provider exercising it.

## 1.1 What this deliberately does not do

- **No invite-by-email.** The target must already be an ACTIVE membership. A provider who wants a new
  assistant asks the owner to invite them through the existing member flow first. Reconsider if the
  two-step ask turns out to be the friction; the pattern to copy is `inviteProvider` (§10).
- **No delegation of anything but availability and bookings.** Not the catalogue, not locations, not
  members, not billing, not the Google Calendar connection (§2.4).
- **No re-delegation.** A delegate cannot pass a diary on (§2.3).
- **No cross-tenant grant.** Structurally impossible, because a grant names a membership (§2.4).
- **No organization-wide default.** A provider created tomorrow has no delegates, and somebody has to
  say so. Named as the top item in §10 because it is the trap this design ships with (§6.5).

---

# 2. Decisions

## 2.1 Delegation narrows ASSISTANT rather than adding a role

The alternative was additive: leave `ASSISTANT` holding `booking:*:all` and let a grant add only
availability. It is the smaller change and it was rejected, because it leaves the model still unable to
express the thing being asked for. A grant would then be a UI convenience — "which diaries do I show
first" — rather than a boundary, and the front desk of a twelve-provider clinic would still be able to
cancel an appointment for a provider nobody has connected them to.

So the role changes:

| | before | after |
| --- | --- | --- |
| `booking:read:all` | ✓ | — |
| `booking:manage:all` | ✓ | — |
| `booking:read:delegated` | — | ✓ |
| `booking:manage:delegated` | — | ✓ |
| `availability:manage:delegated` | — | ✓ |
| `tenant:read`, `member:read` | ✓ | ✓ |

`OWNER` and `ADMIN` deliberately do **not** gain the `:delegated` permissions. They hold `:all`, which
subsumes them, and a role holding both makes a branch of `canForProvider` that can never be reached —
dead weight in the one table nobody may misread. Asserted as a table invariant in `policy.test.ts`.

`PROVIDER` does not gain them either, which is a choice worth naming: a provider covering a colleague's
diary during leave is a real request, and it is one line in this table when somebody asks for it. It is
left out now because nobody has, and a permission granted speculatively is a permission nobody tests.

## 2.2 The backfill reproduces yesterday exactly, and may never round up

**Read this before changing the backfill.** Removing `booking:*:all` from `ASSISTANT` takes every front
desk in every organization off every diary at once, and the first anybody hears of it is a receptionist
who cannot open the morning's list. So the migration writes a grant from every non-archived provider to
every ACTIVE `ASSISTANT` membership, and behaviour on deploy day is unchanged.

The scope is `{BOOKINGS}` **only**, and that is the load-bearing line. An `ASSISTANT` never held
`availability:manage:all`, so granting `AVAILABILITY` here would *widen* access under cover of a
compatibility backfill — the kind of change that is invisible in a diff titled "no behaviour change".
A backfill may reproduce yesterday exactly; it may never round up.

Two exclusions:

- **Archived providers are skipped.** They take no new bookings, and a grant manufactured here would sit
  on every Delegates panel forever. Note the deliberate asymmetry with §2.8: an *existing* grant
  survives archiving. Skipping is about not inventing rows, not about what archiving means.
- **The membership that _is_ the diary is skipped.** It already holds the `:own` permissions. A grant
  would add nothing, and a row that grants nothing is the first place somebody looks when access
  mysteriously stops.

It is a second migration file rather than an addition to the first, so the DDL stays byte-identical to
what Prisma generated and the data change can be read, re-run and reverted on its own. `ON CONFLICT DO
NOTHING` makes it idempotent.

## 2.3 The granter is whoever may manage that diary — and `canDelegateProviderDiary` has no delegated branch

**Read this before touching `canDelegateProviderDiary`.**

Who may grant is `canForProvider` with `{ all: AVAILABILITY_MANAGE_ALL, own: AVAILABILITY_MANAGE_OWN }`
— the provider for their own diary, an owner or admin for anyone's. Owners and admins are included not
as a convenience but because they already hold `:all`: they can do every delegated act themselves, so
withholding the ability to name a delegate would protect nothing and would leave a provider with no
login unable to have a delegate at all.

What is **absent** from that call is the `delegated` key, and that omission is the single most important
line in this feature. With it, an assistant handed a diary could hand it on, and the set of people who
can reach a provider's calendar would grow without the provider, the owner, or the audit log naming
anybody who decided it. Delegation is one level deep by construction rather than by convention: there is
no depth counter, no cycle check, and none is needed.

## 2.4 The delegated set lives inside `Actor.membership`, not beside it

`Actor` gains `membership.delegated`, a map from `:delegated` permission to the provider ids that grant
confers. Two things about that placement are deliberate.

**Inside `membership`, not beside it.** The set can only be reached through the object that also carries
`tenantId`, so there is no way to hold a delegated set that is not stamped with the tenant it came from.
A person assisting at two clinics resolves a different membership per request and therefore a different
set; there is no representable state in which one tenant's grants are consulted for another's resource.
That is why "a grant cannot cross a tenant boundary" needs no runtime check — though `canForProvider`
re-asserts `isMemberOf` anyway (§4.2), because `can()` short-circuits for a platform admin without ever
comparing tenants.

**Keyed by permission, not by scope.** `canForProvider` is then one lookup with no scope vocabulary in
it: it is handed a permission and finds the ids indexed by it. The word `BOOKINGS` appears in exactly one
table, `DELEGATION_SCOPE_PERMISSIONS`, so adding a scope later is an edit there and nowhere else
(rule 10). It is also what keeps `canManageIntegration` closed: that rule is simply never given a
`delegated` key, so no scope can reach it. A connected Google Calendar is a *setting*, not a day's work,
and `policy.test.ts` already asserts an assistant cannot touch one — that assertion is left untouched on
purpose, as the pin holding this decision in place.

## 2.5 Scopes are a Postgres enum array

Three candidates:

| candidate | verdict |
| --- | --- |
| two booleans `manages_availability` / `manages_bookings` | Every new scope is a migration *and* an edit to every read path and response schema. `(false, false)` is a representable non-grant. Worst: the policy layer wants set membership, so a boolean pair forces a translation at every call site — which is `DELEGATION_SCOPE_PERMISSIONS`, now duplicated. |
| a join table | Three tables for a two-element set, and the hot path — "load every grant for this membership" — becomes a join on every request. |
| **`DelegationScope[]`** | Matches the existing idiom for a small closed set read on every load and never queried in reverse (`Provider.languages`, `CalendarIntegration.scopes`). An *enum* rather than `TEXT[]` because the set is closed and the schema already reaches for enums when it is. Round-trips 1:1 with the request body. |

Accepted cost: there is no useful index for "which memberships hold AVAILABILITY on provider X". Nothing
asks that — every read is keyed by `(tenant_id, membership_id)` or `(tenant_id, provider_id)` and filters
scopes in memory.

A hand-written `CHECK (cardinality(scopes) > 0)` is appended to the generated migration, following
`20260729051900_availability_check_constraints`. An empty array would read as "delegated" on every screen
and confer nothing — a revocation wearing a grant's clothes. `prisma migrate diff` does not model CHECK
constraints, so this does not disturb `db:drift-check` (rule 1).

**No composite `(tenant_id, provider_id)` foreign key**, though it is the structurally stronger answer to
"can a row name a provider in another tenant". `migrate diff` *does* model foreign keys, so an FK the
datamodel does not imply reads as drift and breaks the single most important step in CI. What closes the
hole instead is that every read is tenant-keyed (§4.4) and every downstream lookup is tenant-scoped by
rule 5, so a mis-tenanted row would name a provider that 404s.

## 2.6 One row per (diary, membership); a `PUT` re-scopes

`@@unique([providerId, membershipId])`, and the write is
`PUT /v1/providers/:providerId/delegations/:membershipId`. Granting to somebody who already has a grant
is the commonest mistake in a two-admin organization, and a `POST` that 409s on it pushes a
"create or update?" branch into the UI for no gain.

This is **not** the whole-set `PUT` that phase-2-3 §2 constrains, and the distinction matters because
that rule is otherwise absolute. §2's rule is that a body which *replaces a set* may only be built from a
full read of that same set — it exists because two people editing different rows of one list clobber each
other. Here the resource in the URL is a single grant and the body describes only that grant. Offering
the delegate list as one whole-set `PUT` is precisely what §2's reasoning says not to do.

## 2.7 Revocation is a hard delete, and rule 11 does not reach here

Rule 11 keeps catalogue rows alive so that a booking's foreign keys still resolve and a renamed service
does not strand a year-old appointment. Nothing points at a delegation. Deleting one breaks no join and
loses no history that matters, because the audit log holds the history that does.

A `revokedAt` column would put `revokedAt IS NULL` into every read path, and forgetting it once is not a
cosmetic bug — it is a live privilege leak in the one table whose whole job is deciding access. The
availability module already makes this argument for hard-deleting an exception.

Revocation takes effect on the delegate's **next request**, with no session invalidation and no cache,
because the set is loaded per request in `tenant-context.plugin.ts` (§4.4). That is the payoff for
loading it there rather than stamping it into a session at sign-in.

## 2.8 A grant survives a role change, a suspension and an archive

| event | grant rows | effect |
| --- | --- | --- |
| membership SUSPENDED | survive | delegate is locked out by the existing status throw; un-suspending restores the provider's configuration rather than silently discarding it |
| membership removed | cascade away | the grant is to a membership, not a person (rule 9) |
| role changed away from ASSISTANT | **survive, and confer nothing** | see below |
| provider archived | survive, and keep working | an archived diary still owns bookings the front desk must cancel |
| tenant SUSPENDED / CLOSED | survive | grant and revoke are refused by `requireWritableTenant`; reads still work |

The role-change row is the one that was actually decided rather than fallen into. A stale grant is inert
because eligibility is a *permission* question (§2.11): the new role holds no `:delegated` permission, so
`can()` fails before the set is ever consulted. Deleting the rows instead would mean an admin's temporary
role change silently destroys configuration belonging to the **provider**, who was never asked — and the
provider is the one this whole feature exists to give a say.

The consequence, stated rather than discovered later: an `ASSISTANT → ADMIN → ASSISTANT` round trip
revives every grant the member ever held. That is defensible — the provider granted them and nobody
revoked them — but it is surprising, so the Delegates panel labels a row whose role no longer receives
delegations, and there is a test pinning the behaviour so a future reversal is a failing test rather than
a silent change of mind.

## 2.9 The availability `GET`s are narrowed; the slot search is not

`GET /providers/:id/working-hours` and `GET /providers/:id/availability-exceptions` were guarded by
`TENANT_READ`, which every staff role holds — so any member could read any provider's schedule, including
`AvailabilityException.reason`, which the module treats as staff-private and deliberately keeps out of its
audit snapshot. Both now ask the same question the writes ask.

Without this, decision 2.1 is only half true: an assistant with no grant would still read every diary in
the organization and simply be unable to save. The named cost is that it is a scope reduction for
`PROVIDER` too — a provider could read a colleague's hours and now cannot. Nothing in `apps/web` depends
on it (`availability-screen.tsx` fetches only the resolved provider), but it is behaviour nobody asked to
change, so it belongs in the manual walk rather than only in a diff.

`POST /v1/slots/search` **stays** on `TENANT_READ`, and that is not an inconsistency. A receptionist with
a grant on one provider still has to answer "when could somebody see me this week", and a search that
silently omits providers returns a *wrong* answer rather than a narrower one — the worst failure mode
available, because it looks like a full answer. What it exposes is free/busy, strictly less than the
public booking page already shows a stranger. The write stays closed: `POST /v1/bookings` asks
`canManageProviderBookings` about the body's provider, so finding a slot on an undelegated diary and
trying to book it is a 403.

## 2.10 Where the Delegates panel lives, and why not on the Providers screen

On the **availability screen**, below Working hours and Exceptions. The reason is decisive rather than
aesthetic: a `PROVIDER` holds no `provider:manage`, so the navigation filter removes the Providers screen
for them entirely (phase-9-provider-onboarding §2.9). Putting delegation there would make the primary
granter — the provider — unable to grant.

The availability screen is already the one screen a provider reaches for their own diary, and phase-2-3
§2.9 already put diary decisions there. Owners and admins arrive at the same screen from the existing
`?providerId=` link on each Providers row, so there is no new navigation and no second entry point.

## 2.11 Eligibility is a permission question, which is what makes a stale row inert

`roleCanReceiveDelegation(role)` asks whether that role's permission set contains any member of
`DELEGATED_PERMISSIONS` — never `role === "ASSISTANT"` (rule 10). Three things follow, and only the first
was the goal:

1. Re-scoping which roles may receive a diary is an edit to `ROLE_PERMISSIONS` and nothing else.
2. `tenant-context.plugin.ts` loads grants for exactly the roles that could use them, so every other
   request costs what it cost yesterday — and a role that gains a `:delegated` permission later starts
   loading its grants with no edit to the plugin.
3. A grant held by a membership whose role no longer receives delegations confers nothing, with no
   sweep, no cleanup job and no cascade (§2.8).

## 2.12 The affected-bookings dialog crossed a scope boundary

Splitting availability from bookings created a leak that could not exist before, because nobody could
hold one without the other. `affectedBookingSchema`
([schedule-conflicts.ts:38](../packages/contracts/src/schedule-conflicts.ts#L38)) carries
`customerName`, and `SCHEDULE_CONFLICTS_BOOKINGS` is raised by a *working hours* save. So an
AVAILABILITY-only delegate saving a week would receive customer names for bookings on a diary whose
bookings they may not read.

`customerName` is therefore nulled unless `canReadProviderBookings` says otherwise. The dialog still
works: the reference, the time, the service and the count are what the decision needs, and the schema's
own comment already argues for that minimum.

---

# 3. Schema

## 3.1 The model

`ProviderDelegation` in [schema.prisma](../packages/db/prisma/schema.prisma), placed with the provider
cluster rather than with availability: it states *who runs* a diary, not anything about time.

Foreign keys, and why each is what it is:

- `tenantId → Tenant`, `Cascade`. Every table does.
- `providerId → Provider`, **`Cascade`** — deliberately unlike `Membership.providerId`'s `SetNull`. A
  membership that loses its provider still carries a person's access, so nulling is the conservative act
  there. A delegation that loses its diary is not a degraded grant; it is nothing at all.
- `membershipId → Membership`, `Cascade`. Rule 9: the grant is to a membership.
- `grantedByUserId`, **no foreign key**, nullable — recorded, not enforced, matching
  `Membership.invitedByUserId`. The granter may have left. `NULL` means the backfill wrote the row.

## 3.2 The two migrations, and why the backfill is the second

See §2.2 and §2.5. Backfilled rows use `gen_random_uuid()::text` rather than a cuid2: the column is TEXT,
nothing parses it, and the different shape plus the `NULL` granter makes a backfilled row identifiable at
a glance.

## 3.3 What the database does not enforce, and what does instead

Nothing at the schema level stops a row naming a provider in one tenant and a membership in another. See
§2.5 for why the composite FK that would was rejected, and §4.4 for the read that makes such a row
invisible.

---

# 4. Authorization

## 4.1 The permission table, before and after

§2.1.

## 4.2 `canForProvider`, three branches

`:all` → `:own` → `:delegated`, in that order, with `delegated` an *optional* key so a rule that is not
delegable simply omits it (§2.4). The delegated branch re-asserts `isMemberOf`, which looks redundant
beside `can()` and is not: `can()` returns true unconditionally for a platform admin without comparing
tenants, so without it a membership resolved for another tenant could supply the set. A platform admin
holds no memberships (rule 9) and has already returned at branch 1, which makes the line unreachable
today — and exactly the sort of unreachable that stops being so.

## 4.3 `providerIdsInScope`, and why an empty set may never spell "all"

The bookings list narrows rather than refusing: "show me my bookings" is what an actor without `:all`
meant, and a 403 for omitting a filter they cannot know to send is unhelpful. That narrowing used to
produce one provider id or a 403; it now produces a set.

The failure this exists to prevent is an empty set being read as "no filter" and listing the whole tenant
— rule 10's "an unpopulated field must never widen access", which the previous code stated in a comment
and enforced with an `undefined` check. So the return type is a discriminated union,
`{ kind: "all" } | { kind: "some", providerIds }`, not `string[] | null`: a caller that forgets the `all`
case gets a type error, and a caller handed `{ kind: "some", providerIds: [] }` cannot spell it the same
way as no filter.

## 4.4 The one extra query per request, and who pays it

`tenant-context.plugin.ts` loads the grants inside the same memoized block that resolves the membership,
keyed `{ tenantId, membershipId }` (rule 5 — and it is also what makes a mis-tenanted row invisible
rather than dangerous). It runs only when `roleCanReceiveDelegation(membership.role)`, so OWNER, ADMIN,
PROVIDER and CUSTOMER requests are unchanged, and after the non-ACTIVE membership throw, so a suspended
member does not pay for it either.

---

# 5. API surface

## 5.1 Routes

| method | path | who | body → result |
| --- | --- | --- | --- |
| `GET` | `/v1/providers/:providerId/delegations` | `canDelegateProviderDiary` | who holds this diary |
| `GET` | `/v1/providers/:providerId/delegations/candidates` | `canDelegateProviderDiary` | eligible memberships, with `alreadyDelegated` |
| `PUT` | `/v1/providers/:providerId/delegations/:membershipId` | `canDelegateProviderDiary` | `{ scopes }` → grant or re-scope |
| `DELETE` | `/v1/providers/:providerId/delegations/:membershipId` | `canDelegateProviderDiary` | 204 |
| `GET` | `/v1/me/delegations` | any member | whose diaries do I hold, in this tenant |

The write surface hangs off the diary because **the diary is the resource being granted**, the same
reason working hours do. A top-level `/v1/delegations` would put the provider id in the body and make
"may I edit this?" a body-dependent question.

The candidates route exists rather than filtering `GET /v1/members` client-side because the eligibility
rule — ACTIVE, role holds a `:delegated` permission, not this diary's own login — would otherwise live in
`apps/web` as a role-string comparison, breaking rule 10 at the place it matters most. `/v1/members` also
returns owners and admins, so the picker would offer "delegate to the owner" and then refuse it.

## 5.2 Errors

`DELEGATION_TARGET_INELIGIBLE` is distinct from `FORBIDDEN` because they are about different people.
`FORBIDDEN` says the caller may not; this says the person they named cannot receive it. A screen that
cannot tell them apart tells the wrong person to go and ask for permission.

A provider or membership in another tenant is a plain 404, identical to one that does not exist (rule 5).

## 5.3 Audit events

`delegation.granted`, `delegation.rescoped`, `delegation.revoked`, `entityType: "ProviderDelegation"`,
written through `request.audit()` — these are membership-class changes, not inside a booking transaction.
Two actions rather than one for the upsert, so "when did this person first get this diary" stays one grep.

**Ids only in the snapshot, never the target's name or email.** `audit.plugin.ts`'s `FORBIDDEN_KEYS`
scrubs `customerEmail` and `customerName` but nothing about a member, and audit rows are a twelve-month
sink (rule 6).

---

# 6. Web

## 6.1 The provider's Delegates panel

§2.10. The render condition mirrors `canDelegateProviderDiary` exactly — including the absent delegated
branch — so a delegate never sees a panel the API would refuse.

## 6.2 The assistant's diary picker

Availability and bookings both become three-way: every provider for `:all`, otherwise own plus delegated,
otherwise an empty state. The empty state is distinct from the existing "not linked to a diary" one,
because they are different problems with different fixes.

## 6.3 Navigation — the two literals that would have shipped this invisible

`apps/web` does not depend on `@bam/auth`; permission strings are literals and nothing type-checks them
(phase-9-provider-onboarding §7.5). Two of them decide whether this feature is reachable at all:
`dashboard-shell.tsx`'s Bookings item lists `booking:read:all`, which an `ASSISTANT` no longer holds, and
the Availability item is appended only for a membership that names a provider. Left alone, the change
removes Bookings from every front desk and never offers Availability to anyone it was built for.

## 6.4 Localization

Both `hu.json` and `en.json` or neither — `messages.test.ts` asserts exact key parity.

## 6.5 The day-2 trap

A provider created *after* the migration has no delegates, and the front desk silently loses them. The
backfill fixes yesterday; nothing fixes tomorrow — and because the backfill makes deploy day invisible,
this arrives weeks later, when nobody connects "the receptionist cannot see Dr. Nagy" to a migration.

Mitigated the way phase-2-3 mitigated the same class of problem — configuration that looks finished and
produces nothing — with a `Callout tone="action"` on an empty Delegates panel and a hint on a Providers
row whose diary has none. The real answer is an organization-level default (§10).

---

# 7. Safeguards worth naming

| escalation | closed by |
| --- | --- |
| a delegate hands the diary on | `canDelegateProviderDiary` has no delegated branch (§2.3) |
| a grant in one tenant decides a resource in another | the set hangs off the membership (§2.4), and `canForProvider` re-asserts `isMemberOf` (§4.2) |
| an assistant with no grants lists the whole tenant | `providerIdsInScope` returns `{ kind: "some", [] }`, refused explicitly (§4.3) |
| a BOOKINGS grant edits a schedule | `DELEGATION_SCOPE_PERMISSIONS` maps BOOKINGS to booking permissions only (§2.4) |
| an AVAILABILITY grant reads customer names | `customerName` nulled unless `canReadProviderBookings` (§2.12) |
| an assistant connects a Google Calendar | `canManageIntegration` is never given a delegated key (§2.4) |
| a role change silently restores access | it does, and it is deliberate, labelled and tested (§2.8) |
| a grant is created for another tenant's diary | tenant-scoped lookups, 404 (§5.2) |
| a compatibility backfill widens access | `{BOOKINGS}` only (§2.2) |

---

# 8. Verification

## 8.1 What was built

| Area | Files |
| --- | --- |
| Schema | `ProviderDelegation` + `DelegationScope` in [schema.prisma](../packages/db/prisma/schema.prisma); migrations `20260817101441_provider_delegations` (with the hand-written CHECK) and `20260817101500_backfill_provider_delegations` |
| Authorization | [roles.ts](../packages/auth/src/roles.ts) — three permissions, the rewritten `ASSISTANT` row, `DELEGATION_SCOPE_PERMISSIONS`, `roleCanReceiveDelegation`; [policy.ts](../packages/auth/src/policy.ts) — `DelegatedProviderIds`, `delegatedProviderIdsFrom`, the three-branch `canForProvider`, `canDelegateProviderDiary`, `providerIdsInScope` |
| Request context | [tenant-context.plugin.ts](../apps/api/src/plugins/tenant-context.plugin.ts) — one conditional query, after the status throw |
| API | `apps/api/src/modules/delegations/` (routes, schemas, service, repository, a schema-parity test); `DELEGATION_TARGET_INELIGIBLE` in [error-codes.ts](../packages/contracts/src/error-codes.ts); both plugins registered in [app.ts](../apps/api/src/app.ts) |
| Call sites | both availability `GET`s narrowed; the bookings list rewritten onto `providerIdsInScope` and `providerIds`; `customerName` nulled for a bookings-blind caller; `delegations` added to `/v1/me` |
| Web | `provider-delegates.tsx`, `lib/delegation.ts`, the two diary pickers, the nav, `MeResponse`, both message catalogues |

## 8.2 Deviations from the plan

1. **No `apps/web/src/lib/permissions.ts`.** The plan floated it as a way to stop a permission-string typo
   silently hiding a nav item. Half-migrating the literals is worse than not starting — the file would agree
   with three call sites and not the other twenty — so it stays a gap (§9.1) rather than a partial change.
2. **`lib/delegation.ts` exports `hasPersonalDiary` as well as `diaryScopeFor`.** Not in the plan, and
   necessary: the nav condition is *not* "may reach a diary" but "has one of their own", because reading
   `:all` as "has a diary" would give administrators the top-level Availability item that phase-2-3 §2.7
   removed. That distinction is now a named function with a test rather than an inline expression.
3. **The empty-scope refusal is a 422, not a 400.** Zod rejections surface through `VALIDATION_FAILED`,
   which the error handler serialises as 422 across the whole API. The plan guessed 400.
4. **`PROVIDER` fixtures in `delegation.test.ts` are written through Prisma**, because the generic
   invitation route refuses that role on purpose (phase-9-provider-onboarding §2.11). Exercising that path
   is that suite's job.

## 8.3 Results — 2026-08-17

`pnpm db:drift-check` — no drift. `pnpm lint`, `pnpm check-types` — clean, 23/23 tasks.
`pnpm test` — 23/23 tasks:

- `@bam/auth` 60 passed (was 44; two rewritten, sixteen added)
- `@bam/api` 294 passed, 34 skipped — the skips are Epic 6's parked calendar suites. Includes the new
  `delegation.test.ts` (18) and `delegation.schemas.test.ts` (6), and the rewritten
  `availability.test.ts` assistant block (4, replacing 1)
- `@bam/web` 225 passed, including the new `lib/delegation.test.ts` (10) and the locale parity test
- `@bam/contracts` 57, `@bam/db` 36, `@bam/worker` 113 — untouched

## 8.4 Manual walk

**Not yet performed.** The order to walk it in:

1. Provision an organization through `/platform` and sign in as the owner. Add two providers.
2. Invite an ASSISTANT and accept. **Before any grant:** their nav shows Overview only — no Bookings, no
   Availability. `/dashboard/bookings` by hand returns nothing usable.
3. As the owner, open `/dashboard/availability?providerId=…` from a Providers row. The Delegates panel is
   there with an empty-state callout. Add the assistant with BOOKINGS only.
4. As the assistant: Bookings appears; Availability does not. They see that provider's appointments and not
   the other's.
5. Add AVAILABILITY. Availability now appears, with a picker only once they hold two diaries.
6. As the assistant with AVAILABILITY only, remove a working period that covers a booking: the dialog lists
   it **without a customer name**. As the owner, the same save shows the name. (§2.12.)
7. Give a provider a login, sign in as them, and confirm they can grant on their own diary and get a 403 on
   a colleague's. Confirm a delegate sees no Delegates panel at all.
8. Revoke, and confirm the assistant's very next click 403s without signing out.

---

# 9. Deviations and known gaps

1. **`apps/web` permission strings are still unchecked literals.** The standing risk from
   phase-9-provider-onboarding §7.5, and this change moved three of them. `lib/delegation.ts` concentrates
   the two that decide diary scope, which shrinks the surface without removing it. A
   `lib/permissions.ts` — or, better, letting `apps/web` depend on `@bam/auth` — is the real fix.
2. **A provider created after the migration has no delegates** (§6.5). Mitigated with a callout, not solved.
   §10's first item.
3. **A role round trip revives every grant** (§2.8). Decided, labelled and tested, not fixed.
4. **No tenant-wide delegation overview.** Every row is reachable from a provider's panel, which is enough
   and not convenient.
5. **`POST /v1/slots/search` still shows every provider's free/busy to any member** (§2.9). Deliberate, and
   the one place a delegate sees beyond their grant.
6. **The backfill inserted zero rows locally**, because neither development database had an ACTIVE
   ASSISTANT membership. The statement is asserted by review and by its `ON CONFLICT` idempotency rather
   than by having moved data — worth knowing before it runs somewhere that does have one.
7. **`GET /v1/providers` is readable by any member**, so a delegate can enumerate provider names even for
   diaries they do not hold. Unchanged by this work and out of its scope, but the pickers now depend on it,
   which is the first thing that would break if it were narrowed.

---

# 10. Next

1. **An organization-level default for new diaries** — §6.5. The trap this design ships with.
2. **Invite-by-email**, so a provider can onboard their own assistant without the owner — §1.1.
3. **A tenant-wide delegation overview** for an owner. Every row is reachable from a provider's panel
   today, which is enough but not convenient.
4. **`PROVIDER` receiving delegations**, for covering a colleague's leave — §2.1. One line in the table.
