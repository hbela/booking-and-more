This is the plan for a requirement three phase records have named and none has answered: a provider
hands the running of their diary to somebody else. phase-2-3 §5.9 calls it "neither built nor
designed"; phase-9-provider-onboarding §1.1 says "No delegation" and §7.6 repeats it. The absence was
recorded so it would not read as a decision. This is the decision.

# Phases 3–4 — Diary delegation

## Implementation Record

**Document version:** 1.0 — planned 2026-08-17.
**Scope:** the **owner** assigns a named member to a provider's diary — its availability, its bookings, or
both — and can invite somebody who has no account yet in one emailed action. One member holds assignments
from several providers. The provider sees who assists them and does not choose them. The `ASSISTANT` role is
narrowed from clinic-wide to delegated-only, and a migration backfills the assignments that keep today's
behaviour intact.
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

## 2.3 The owner decides, and only the owner

**Read this before widening who may staff a diary.**

Deciding who assists on a diary is `delegation:manage`, a permission **only OWNER holds**. Not the
administrator; not the provider whose diary it is; not, obviously, a delegate.

The first version of this feature answered differently — the provider, the owner or the admin, expressed as
`canForProvider` over the availability permissions. That was reversed on 2026-08-17, and the reasons are
worth keeping because each one is an argument that will be made again:

- **Staffing is not a property of a diary.** Every other rule here takes a `providerId`, because "may you
  work this diary" is a question about that diary. "May you put somebody on the payroll's rota" has one
  answer for the whole organization, so this rule is tenant-wide and takes no provider at all. The shape of
  the function is the decision.
- **It must be its own permission, not a reading of the availability ones.** ADMIN holds
  `availability:manage:all` and may edit every schedule in the clinic. Expressing the rule as "may manage
  availability" would have handed staffing to administrators silently, and nothing anywhere would have said
  so. The ADMIN row of `ROLE_PERMISSIONS` now has a deliberate gap in it, which is exactly the kind of thing
  that gets "fixed" by a later reader — so `policy.test.ts` asserts the holder list is `[OWNER]` over the
  whole table rather than as a spot check.
- **Re-delegation stops needing a special case.** The previous design turned on `canDelegateProviderDiary`
  omitting its delegated branch, and that omission carried the entire one-level guarantee. Now an ASSISTANT
  simply does not hold `delegation:manage`. There is no depth counter, no cycle check, and no branch to get
  wrong.

### 2.3.1 What the provider keeps

**Reading.** A provider sees who assists on their own diary, and on nobody else's — `canReadProviderDelegates`,
which is `canForProvider` with `{ all: DELEGATION_MANAGE, own: AVAILABILITY_MANAGE_OWN }` and **no delegated
key**, so an assistant cannot enumerate the others. Knowing who else holds a diary is not part of running it.

This is the smallest thing phase-2-3 §2.7 can survive on. That record puts availability in the provider's
hands, and the owner now chooses who else touches it; being *told* who that is, on the screen where their
own week lives, is the difference between a decision made for them and one made behind them.

An ADMIN sees nothing here at all, which is consistent: they cannot decide it either.

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

On the **availability screen**, below Working hours and Exceptions — and the reason survived the move to
owner-only staffing, which is worth noting because it originally rested on the provider being the granter.

A `PROVIDER` holds no `provider:manage`, so the navigation filter removes the Providers screen for them
entirely (phase-9-provider-onboarding §2.9). They no longer *decide* who assists them, but they do read it
(§2.3.1), and this is the one screen they reach for their own diary. Putting the panel on Providers would
put it somewhere they cannot go.

One panel, two audiences: the owner gets controls, the provider gets a list. An ADMIN gets nothing — they
cannot read it either.

### 2.10.1 The owner also reaches it from the Providers row — amended 2026-08-18

This section originally added "so there is no new navigation and no second entry point", and the owner's
route was the existing `?providerId=` link on each Providers row. **That was wrong in use**, and the first
attempt to staff a diary by hand is what showed it: the owner opens a provider's diary, scrolls past Working
hours and Exceptions, and finds Delegates at the foot of a screen whose subject is *time*. Staffing is not a
property of a diary — that is §2.3's whole argument, and the placement said the opposite.

So a **Manage assistant** row action on Providers opens the same panel, beside Edit / Assign / Availability /
Invite. Three things about it are deliberate:

- **The same component, not a simpler one.** `ProviderDelegates` gained `providerName`, `panelProps` and
  `onClose` and nothing else. A cut-down "just add and remove" panel is the tempting version and it is how
  the empty-scope refusal (§6.1), the stale-role badge (§2.8) and the once-only invitation link (§6.1) come
  to hold on one screen and not the other.
- **Gated on `delegation:manage`, not on `provider:manage`.** Every other control in that row cell is behind
  one of those two, and reusing either would hand staffing to an ADMIN silently — the exact failure §2.3
  names as the reason this is its own permission. The gap in the ADMIN row of `ROLE_PERMISSIONS` is only a
  decision if the screens read it.
- **The availability panel stays.** It is the provider's only route to it (§2.10), and a PROVIDER holds no
  `provider:manage`, so removing it would take the read away from the one person §2.3.1 exists for.

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

## 2.13 The invitation carries the assignment

**Read this before touching `inviteDelegate` or `claimInvitation`.**

Bringing in an assistant used to take two people and two screens: the owner invited them into the
organization from Overview, then somebody assigned them to a diary. It also produced **no email at all** —
`POST /v1/members/invitations` writes no outbox row, so the "copy this link" text was the entire delivery
mechanism (phase-1 §5.1). That is how the gap was found: an owner sent an invitation and nothing arrived.

So the owner now does it in one action, from the Delegates panel:
`POST /v1/providers/:providerId/delegations/invitation` with an address and the scopes. The invitation
carries `delegatedProviderId` and `delegatedScopes`, it is emailed, and **acceptance creates the membership
and the assignment in the same transaction that burns the token**.

That atomicity matters more here than it does for a provider's own link. A PROVIDER whose membership names
no diary at least holds a role people recognise; an **ASSISTANT with no assignment can see nothing at all** —
no Bookings item, no Availability item, an empty dashboard. A half-completed acceptance would be
indistinguishable from a permissions bug, and the person it happened to would have no way to describe it.
`claimInvitation` re-reads the diary inside the transaction and refuses an archived one, exactly as it does
for the provider link, and for the same reason: the diary may have been archived between the email being
sent and the link being clicked.

### 2.13.1 Two columns, not one

`Invitation.providerId` already exists and means "this membership **is** this diary". The new
`delegatedProviderId` means "this membership **assists on** this diary". They cannot share a column, and not
only because the meanings differ: `invitations_provider_pending_key` allows at most one live invitation per
diary, which is right for a login and wrong for an assistant. Sharing would make a provider's own pending
invitation and a pending assistant invitation mutually exclusive, for a reason nobody could discover from
the error.

A CHECK keeps the two new columns consistent — a diary with no scopes, or scopes with no diary, is a grant
that means nothing.

### 2.13.2 One address, one live invitation — the rule that won

The first draft added `invitations_delegated_diary_pending_key` so that one person could hold two live
invitations, one per diary. **It could never fire.**
`invitations_tenant_email_pending_key` has allowed exactly one live invitation per address per tenant since
Epic 1, and that rule is older, broader and deliberate: it is what makes "resend" unambiguous, because the
newest link is always the only one that works.

The index was dropped in its own migration rather than edited out of the one that added it (rule 1 covers
undoing a migration as much as making one). The consequence is real and is now asserted: inviting somebody
for a second diary **supersedes** their first invitation. Giving one person two diaries means letting them
accept one and then assigning the second — which is what the two separate actions on the panel are for.

### 2.13.3 Somebody who is already a member is refused

Not silently converted into an assignment. A button that sometimes sends an email and sometimes quietly does
something else is worse than one that says "assign them from the list instead" — and the list is right there.

## 2.14 Two people on one diary — what protects them, and what does not

**Read this before adding any second editor to anything.** Added 2026-08-18, after the question "how do we
manage conflict between a provider and her assistant" was asked of the finished feature. The audit below is
the answer, and one of its four rows is a defect this epic made much more likely to fire.

| conflict | what happens today |
| --- | --- |
| both act on the same **booking** | Refused cleanly. The state machine makes terminal terminal — nobody un-cancels, because cancelling releases the capacity reservation and the slot may already be resold ([transitions.ts](../packages/booking-engine/src/transitions.ts)) — the exclusion constraint on `capacity_reservations` decides who got a slot rather than a read-then-write (rule 14), and retryable writes carry an `Idempotency-Key` (rule 16). |
| an **availability** edit strands a booking | Handled, and this was already the cross-role case: `SCHEDULE_CONFLICTS_BOOKINGS` returns the list once and succeeds on re-send with `acknowledgeAffectedBookings` (phase-3-4 §2.4). A BOOKINGS-blind delegate acknowledges it **without customer names** (§2.12) — deliberate, and it means their acknowledgement is made on less than the provider would have. |
| both edit the **same week** | Refused, since 2026-08-18: a content fingerprint issued by the `GET` and echoed by the `PUT`, compared inside the replace transaction under a lock on the provider row, answering the loser with `SCHEDULE_MODIFIED` (409). **This row read "Nothing" when the audit was written** — §2.14.1 is the defect, §2.14.3 the fix, and they are kept apart because the shape recurs wherever a whole set is replaced. |
| they simply disagree | Not a software question. §2.3 gives the provider no way to revoke their own assistant, so their recourse is the owner. Stated here because it is a consequence of owner-only staffing that somebody will otherwise report as a bug. |

### 2.14.1 The whole-week save had no concurrency control

**Fixed on 2026-08-18 by §2.14.3**, and the first version of that fix did not close it either — see the
lock. Kept in the past tense below because the defect is the reason the rest of this section exists, and
because the shape of it recurs wherever a whole set is replaced.

[`replaceWorkingHours`](../apps/api/src/modules/availability/availability.repository.ts) was a
delete-then-insert inside a transaction, with no version column, no `If-Match` and no `updatedAt` check. The
whole-set `PUT` rule (phase-2-3 §2) requires the body be built from a full read of that set, and the editor
does that — but **nothing checked the read was current**. So: the provider opens her week, the assistant adds
Friday afternoon and saves, the provider saves her stale form, and Friday afternoon disappears with no error
and no trace either of them will ever see.

The bug predated this epic. What this epic changed is its probability: before delegation it took two owners
editing one diary, which is rare. **An assistant is a second editor by design**, so the expected
configuration became the one that triggers it.

### 2.14.2 The visibility half, built first

Shipped on 2026-08-18, before the fix and deliberately kept after it: `GET …/working-hours` gained
`lastChange`, and the editor renders *"Last changed by Réka, 10 minutes ago"*.

It prevents nothing, and it is still worth having after §2.14.4: the version check refuses a *collision*,
while this answers "has anything moved since I last looked" on a screen nobody is mid-save on. Four decisions
inside it:

- **The audit log is the source, not a column.** The row is already written on every save; a whole-week
  replace would reset any `updatedBy` we put on `working_hours`, including on the rows the save did not
  change; and a second source of one fact is a second thing to keep true. It also meant **no migration**.
- **On the existing `GET`, not an endpoint of its own.** It describes exactly the set being returned, and two
  requests could disagree — a week from one moment attributed to a save from another.
- **It is eventually consistent, deliberately.** `request.audit()` is fire-and-forget, because an audit
  failure must never fail a schedule save. So the line can lag by a moment — which only ever affects
  attributing *your own* save right after making it, the one case the reader already knows the answer to.
  The integration test asserts through the API with `vi.waitFor` rather than reaching into the table, so it
  proves the model the screen actually sees.
- **`AuditLog.actorId` has no foreign key to `User`**, so the name is a second lookup and a miss renders as a
  time with no name rather than a missing line. An audit trail that cascades away when an account is deleted
  is not an audit trail.

### 2.14.3 The fix — a content fingerprint, checked inside the transaction

Built 2026-08-18, immediately after §2.14.2. `GET …/working-hours` returns a `fingerprint`; the `PUT`
requires it back as `expectedFingerprint`; a mismatch is `SCHEDULE_MODIFIED` (409) carrying the current
fingerprint and `lastChange`. **Still no migration.** Five decisions, each of which was the second thing
tried or the thing that made the first wrong:

- **Content, not identity.** The obvious fingerprint is the row ids — every save mints new ones, since the
  replace is delete-then-insert. It was rejected: two saves producing an *identical* week would then
  conflict, and refusing somebody because a colleague saved the very hours they are looking at is a dialog
  about nothing. Hashing the fields also survives a partial-update writer that does not exist yet; an
  id-based hash would not notice one. Asserted both ways in `working-hours-fingerprint.test.ts`.
- **Sorted here, not trusted from the query.** The repository orders by `(weekday, startTime)`, which is not
  a total order — two periods can share both and differ by location. Without sorting the serialised tuples,
  one week could fingerprint two ways and refuse a caller who did nothing wrong.
- **Compared inside the replace transaction, under a lock on the provider row.** Comparing in the service,
  before the call, leaves exactly the window the check exists to close: between "still matches" and
  `deleteMany`, the other editor commits and is deleted anyway. The check shipped that morning with **no row
  lock**, on the argument that two transactions which both pass have by definition read the *same* week, so
  the loser overwrites a body that saw everything the winner saw. **That argument was wrong**, and
  [the code review](code-review-2026-08-18.md) found it the same day as its first P1: two bodies built from
  the same base are not the same body. Alice adds a Monday period while Bob changes Tuesday; both read `F0`,
  both pass under READ COMMITTED because neither has committed yet, and the later `deleteMany` erases the
  earlier replacement. "Both saw the same starting week" says nothing about whether their *edits* agreed —
  the argument confused the read with the write. So the transaction now opens with
  `SELECT id FROM providers … FOR UPDATE`. **The provider row, and not the working-hours rows**: an empty
  week has no row to lock, and delete-then-insert changes their identities anyway, so the set being replaced
  can never be its own lock target — the row it hangs off is the stable one. With the lock held, competing
  saves queue, and the second reads the winner's replacement and fails its own fingerprint check instead of
  overwriting it. The fingerprint stays the *user-facing* conflict detector; the lock is the *serialization
  mechanism*, and the split is the point. `availability.test.ts` asserts a real race with `Promise.all`
  rather than a stale-token sequence — exactly one 200 and one 409, and the surviving week is one of the two
  bodies whole rather than a merge of both. A sequence proves the comparison works and proves nothing about
  the transaction.
- **Required, but refused in the handler rather than by Zod.** `requireScheduleFingerprint` mirrors
  `requireIdempotencyKey` exactly, and for the reason `idempotencyHeaderSchema` records: Fastify validates
  the body **before** the preHandler, so a required field would answer a caller with no permission on this
  diary with a 422 about a missing field instead of a 403. There is a test pinning that ordering. It also
  earns its own code — `SCHEDULE_FINGERPRINT_REQUIRED` — because "you did not read before writing" is a
  different fix from "your body is wrong". This is phase-2-3 §2's rule finally enforced by the server
  instead of trusted to the client.
- **A different code from `SCHEDULE_CONFLICTS_BOOKINGS`**, though both are 409s on this one route, and the
  screens must never merge them: that one means "your change costs these appointments, confirm it" and is
  re-sent acknowledged; this one means "you are about to undo work you have not seen" and may **never** be
  re-sent as-is. `scheduleModifiedBy` returns `undefined` for "not this error" and `null` for "this error,
  nobody to name", so a lagging audit trail still stops the save.

On the web side the fingerprint is seeded into state **in the same effect as the week**, never read from the
query at submit time: a background refetch updates the query one render before the effect re-seeds the form,
and reading it there would send the new fingerprint with the old body — the precise stale write this refuses.
The refusal renders as a callout naming the other editor with a Reload button, and the copy says *before* the
press that reloading replaces what is on screen.

### 2.14.4 The trail exists and nobody can read it

Availability writes have been audited with the acting user since Epic 3
([availability.routes.ts](../apps/api/src/modules/availability/availability.routes.ts),
[audit.plugin.ts](../apps/api/src/plugins/audit.plugin.ts)). **There is no audit-viewing UI anywhere in
`apps/web`** — the `lastChange` line is now the only audit data any user of this product can see. "Who
changed my Friday, and to what?" still needs database access. Named as a gap (§9.9) rather than solved,
because a general audit screen is its own piece of work.

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
| `GET` | `/v1/providers/:providerId/delegations` | owner, or that provider | who assists on this diary |
| `GET` | `/v1/providers/:providerId/delegations/candidates` | owner | eligible members, with `alreadyDelegated` |
| `PUT` | `/v1/providers/:providerId/delegations/:membershipId` | owner | `{ scopes }` → assign or re-scope |
| `DELETE` | `/v1/providers/:providerId/delegations/:membershipId` | owner | 204 |
| `POST` | `/v1/providers/:providerId/delegations/invitation` | owner | `{ email, scopes }` → emailed invitation (§2.13) |
| `GET` | `/v1/me/delegations` | any member | whose diaries do I assist on, in this tenant |

Everything but the first read is a plain `requirePermission(DELEGATION_MANAGE)` guard, because the answer
does not depend on which diary is in the URL (§2.3). The first read does, so it asks
`canReadProviderDelegates` in the handler.

The write surface hangs off the diary because **the diary is the resource being staffed**, the same reason
working hours do. A top-level `/v1/delegations` would put the provider id in the body and move the tenant
check away from the route that needs it.

The candidates route exists rather than filtering `GET /v1/members` client-side because the eligibility rule
— ACTIVE, role holds a `:delegated` permission, not this diary's own login — would otherwise live in
`apps/web` as a role-string comparison, breaking rule 10 at the place it matters most. `/v1/members` also
returns owners and admins, so the picker would offer "assign the owner" and then refuse it.

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

## 6.1 The Delegates panel — one panel, two audiences

§2.10. The owner gets **Assign an existing member** and **Invite someone new**, scope checkboxes on every
row, and Revoke. The provider gets the same list rendered as text.

Read-only means *text*, not disabled checkboxes: a disabled control invites the reader to work out how to
enable it, and there is nothing they can do. Their empty state says so too — "ask the organization owner if
you need help managing it" rather than the owner's "nobody manages this diary but the provider", because the
two readers have different next actions and only one of them can act.

The invitation's accept link is shown once alongside the "invitation sent" confirmation, for the reason
phase-9-owner-onboarding-emails §2 gives: the worker memoises its email provider at boot, and one that
cannot deliver writes SKIPPED rather than a fake SENT. Without the link an owner in that state has no
recovery path at all.

## 6.2 The assistant's diary picker

Availability and bookings both become three-way: every provider for `:all`, otherwise own plus delegated,
otherwise an empty state. The empty state is distinct from the existing "not linked to a diary" one,
because they are different problems with different fixes.

## 6.3 Navigation — where a permission stopped being enough

`apps/web` does not depend on `@bam/auth`; permission strings are literals and nothing type-checks them
(phase-9-provider-onboarding §7.5). Two of them decide whether this feature is reachable at all:
`dashboard-shell.tsx`'s Bookings item listed `booking:read:all`, which an `ASSISTANT` no longer holds, and
the Availability item was appended only for a membership that names a provider. Left alone, the change
removes Bookings from every front desk and never offers Availability to anyone it was built for.

**Adding `booking:read:delegated` to that list is the obvious fix and it is wrong**, which is worth stating
because it was written that way first and looked finished. An `ASSISTANT` holds that permission from the
moment they join and reaches nothing until a provider hands them a diary, so the item would render for
every assistant in every organization and 403 on click — the precise failure §2.9 removed for owners. The
same is true of a `PROVIDER` holding `booking:read:own` whose membership names no diary.

So **a permission is no longer a sufficient gate for these two items, and data is the second one**. Three
of the four booking and availability permissions authorise nothing by themselves; holding one says only
that the caller *could* be given a diary. `NavItem.requires` asks whether they have been.

The two items differ in which question they ask, deliberately. Bookings uses `hasAnyDiary`, so an
administrator sees it — the whole organization's day is genuinely their screen. Availability uses
`hasPersonalDiary`, which is **false for an administrator on purpose**: a diary belongs to a provider, and
an owner reaches one at a time from the Providers row (phase-2-3 §2.7). Reading `:all` as "has a diary"
would quietly restore the top-level entry that record removed.

The whole decision moved to `lib/dashboard-nav.ts` as a pure `navFor(me)` — both gates, in order — for the
reason `member-diary.ts` and `working-hours.ts` are pure: it is the decision, and decisions get unit tests.
`dashboard-nav.test.ts` asserts the resulting nav for every role, including the two empty-handed cases.

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
| a delegate hands the diary on | they hold no `delegation:manage` (§2.3) |
| an administrator staffs a diary | `delegation:manage` is OWNER-only, asserted over the whole role table (§2.3) |
| a provider staffs their own diary | the same permission; they may read the list and nothing else (§2.3.1) |
| an assistant enumerates a diary's other assistants | `canReadProviderDelegates` has no delegated key (§2.3.1) |
| an invitation grants a membership but no diary | both rows are written in one transaction, or neither (§2.13) |
| an invited assistant lands on an archived diary | the diary is re-read inside the acceptance transaction (§2.13) |
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
| Schema | `ProviderDelegation` + `DelegationScope`, and `Invitation.delegatedProviderId` + `delegatedScopes`, in [schema.prisma](../packages/db/prisma/schema.prisma). Five migrations: `..101441_provider_delegations` (with the CHECK), `..101500_backfill_provider_delegations`, `..152753_invitation_carries_delegation` (with its own CHECK), `..154619_assistant_invited_notification`, `..160500_drop_delegated_diary_pending_index` (§2.13.2) |
| Authorization | [roles.ts](../packages/auth/src/roles.ts) — four permissions, the rewritten `ASSISTANT` row, `DELEGATION_SCOPE_PERMISSIONS`, `roleCanReceiveDelegation`; [policy.ts](../packages/auth/src/policy.ts) — `DelegatedProviderIds`, `delegatedProviderIdsFrom`, the three-branch `canForProvider`, `canManageDelegations`, `canReadProviderDelegates`, `providerIdsInScope` |
| Request context | [tenant-context.plugin.ts](../apps/api/src/plugins/tenant-context.plugin.ts) — one conditional query, after the status throw |
| API | `apps/api/src/modules/delegations/` (routes, schemas, service, repository, a schema-parity test); `inviteDelegate` and the acceptance half of `claimInvitation` in `membership.service.ts`; `DELEGATION_TARGET_INELIGIBLE` in [error-codes.ts](../packages/contracts/src/error-codes.ts); both plugins registered in [app.ts](../apps/api/src/app.ts) |
| Email | `ASSISTANT_INVITED` through `@bam/notification-engine` (type, dedupe, planning, hu+en template, scope labels) and the worker's `dispatchAssistantInvited` + sender branch |
| Call sites | both availability `GET`s narrowed; the bookings list rewritten onto `providerIdsInScope` and `providerIds`; `customerName` nulled for a bookings-blind caller; `delegations` added to `/v1/me` |
| Provenance (§2.14.2) | `scheduleLastChangeSchema` and `lastChange` on `GET …/working-hours`; `findLastWorkingHoursChange` in the availability repository; `lib/relative-time.ts` + its test and the `LastChange` line in `working-hours-editor.tsx`; three message keys. No schema change |
| Version check (§2.14.3) | `working-hours-fingerprint.ts` (`fingerprintWorkingHours`, `requireScheduleFingerprint`) + its unit test; `fingerprint` on the working-hours `GET` **and** `PUT`; `expectedFingerprint` on the body; the in-transaction compare and `ScheduleModifiedError` in the repository, converted to `SCHEDULE_MODIFIED` by the service; `SCHEDULE_MODIFIED` + `SCHEDULE_FINGERPRINT_REQUIRED` in `error-codes.ts`; `lib/schedule-modified.ts` + its test and the conflict callout; four message keys. No schema change |
| Web | `provider-delegates.tsx`, `lib/delegation.ts`, the two diary pickers, the nav, `MeResponse`, both message catalogues; the **Manage assistant** row action and panel on `providers-screen.tsx` (§2.10.1) |

## 8.2 Deviations from the plan, and one reversal

**The reversal.** The feature shipped on 2026-08-17 with the provider, the owner *or* the admin able to
staff a diary, and was changed the same day to owner-only, with the provider reading and the admin excluded
(§2.3). What made it necessary was not a defect but a use: the first attempt to bring in an assistant
revealed that it took two people and two screens and sent no email, and simplifying who decides was the
answer to both. §2.13 is the half that fixes the email.

Smaller deviations, in the order they were found:

1. **No `apps/web/src/lib/permissions.ts`.** The plan floated it as a way to stop a permission-string typo
   silently hiding a nav item. Half-migrating the literals is worse than not starting — the file would agree
   with three call sites and not the other twenty — so it stays a gap (§9.1) rather than a partial change.
2. **`lib/delegation.ts` exports `hasPersonalDiary` as well as `diaryScopeFor`, and the whole nav decision
   moved to `lib/dashboard-nav.ts`.** Neither was planned. The nav condition is *not* "may reach a diary"
   but "has one of their own", because reading `:all` as "has a diary" would give administrators the
   top-level Availability item that phase-2-3 §2.7 removed — and gating Bookings on
   `booking:read:delegated` alone put a permanently-403ing link in front of every assistant (§6.3).
3. **The empty-scope refusal is a 422, not a 400.** Zod rejections surface through `VALIDATION_FAILED`,
   which the error handler serialises as 422 across the whole API. The plan guessed 400.
4. **`PROVIDER` fixtures in `delegation.test.ts` are written through Prisma**, because the generic
   invitation route refuses that role on purpose (phase-9-provider-onboarding §2.11).
5. **An index was added and dropped in consecutive migrations** (§2.13.2). It could never have fired, and
   the reason is worth more than the tidiness of pretending it never existed.
6. **The owner's entry point moved to the Providers row** (§2.10.1), on 2026-08-18, during the first attempt
   to walk §8.4 by hand. Web-only: no route, schema, permission or migration changed, and the availability
   panel is untouched.

## 8.3 Results — 2026-08-17

`pnpm db:drift-check` — no drift. `pnpm lint`, `pnpm check-types` — clean, 23/23 tasks.
`pnpm test` — 23/23 tasks, after the owner-only rework:

- `@bam/auth` 65 passed (was 44 before this epic)
- `@bam/api` 300 passed, 34 skipped — the skips are Epic 6's parked calendar suites. `delegation.test.ts`
  is 25, `delegation.schemas.test.ts` 6, and the rewritten `availability.test.ts` assistant block 4
- `@bam/notification-engine` 67 passed, including the new `renderAssistantInvited` and scope-label cases
- `@bam/web` 232 passed, including `lib/delegation.test.ts` (10) and `lib/dashboard-nav.test.ts` (7)
- `@bam/contracts` 57, `@bam/db` 36, `@bam/worker` 113 — untouched

**2026-08-18**, after §2.10.1: `@bam/web` lint, `tsc --noEmit` and 232/232 unchanged. The count does not
move because the panel is the same component with three new optional props, and `messages.test.ts` covers
the three added keys by parity.

**2026-08-18**, after §2.14.2 and §2.14.3: `pnpm lint`, `pnpm check-types`, `pnpm test` — 23/23 tasks;
`pnpm db:drift-check` no drift, and **neither change needed a migration**. `@bam/api` 315 passed (was 301):
`availability.test.ts` gained the provenance case and a six-case `the version check` block, including the one
pinning that a 403 answers before the missing-version does. `@bam/web` 243 (was 232): `lib/relative-time.ts`
7 and `lib/schedule-modified.ts` 4. Four suites' fixtures now read before they write — `availability`,
`delegation`, `booking` and `provider-onboarding` — which is the rule the fingerprint enforces, applied to the
tests as well.

## 8.4 Manual walk

**Not yet performed.** [phase-3-4-diary-delegation-manual-test.md](phase-3-4-diary-delegation-manual-test.md)
is the document to open — preconditions, the setup that has to exist first, and ~50 numbered checks. The
shape of it, in order:

1. Provision an organization through `/platform` and sign in as the owner. Add two providers.
2. Invite an ASSISTANT and accept. **Before any grant:** their nav shows Overview only — no Bookings and
   no Availability, because neither permission they hold reaches a diary yet (§6.3). Typing
   `/dashboard/bookings` by hand still loads the screen and its list 403s: the nav is advisory.
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
   §10's second item.
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
8. **The other three whole-set `PUT`s have no version check** — provider services, provider locations,
   service translations (phase-2-3 §2). Working hours was fixed (§2.14.3) because delegation put two editors
   on it by design; the others are still one-owner-at-a-time in practice, and the fingerprint is small enough
   to lift if that stops being true. `fingerprintWorkingHours` is deliberately named for its table rather
   than generalised on speculation.
9. **No audit-viewing UI** (§2.14.4). The `lastChange` line is the only audit data any user can see; the
   twelve-month trail behind it is reachable only from the database.
10. **Availability *exceptions* have no version check either.** They are per-row create/update/delete rather
    than a whole-set replace, so a concurrent edit cannot clobber a set — but two people can still delete and
    re-add the same day and only the audit log will show it.

---

# 10. Next

1. **An organization-level default for new diaries** — §6.5. The trap this design ships with.
2. **A tenant-wide delegation overview** for an owner. Every row is reachable from a provider's panel
   today, which is enough but not convenient — and now that staffing is entirely the owner's, a single
   screen answering "who assists whom" is the obvious next thing they will ask for.
3. **The generic member invitation still emails nobody** (phase-1 §5.1). Inviting an admin, or an assistant
   from Overview rather than from a diary, is still copy-the-link. This epic closed the half it needed and
   deliberately left the rest.
4. **`PROVIDER` receiving delegations**, for covering a colleague's leave — §2.1. One line in the table.
