This is the execution record for the piece
[phase-2-3-owner-management.md](phase-2-3-owner-management.md) §5.11 named as "the obvious next piece
of work", built on the invitation machinery
[phase-9-owner-onboarding.md](phase-9-owner-onboarding.md) put in place for owners.

# Phase 9 — Provider onboarding

## Implementation Record

**Document version:** 1.0 — built 2026-08-04.
**Scope:** giving a provider a login. One row action on the Providers screen issues an invitation that
carries the diary, emails it, and — on acceptance — creates the account, grants `PROVIDER`, and links
the membership to that diary in the same transaction that burns the token.
**Depends on:** [phase-9-owner-onboarding.md](phase-9-owner-onboarding.md) §2.1 (the invited address is
the only address the route will register), §2.4 (why user creation cannot join the membership
transaction) and §2.5 (why both accept routes exist) — all three now protect two flows rather than one ·
[phase-2-3-owner-management.md](phase-2-3-owner-management.md) §2.7 (who decides what: availability
belongs to the provider), §2.8 (a provider must be reachable) and §5.11 (the gap this closes) ·
[phase-9-owner-onboarding-emails.md](phase-9-owner-onboarding-emails.md) §2 (an `EmailProvider` that
does not deliver must not report success).
**Exit criteria:** An owner can give a provider a login in one action · That person lands on their own
diary, able to set their working hours and see nothing they cannot act on · A membership is never left
holding `:own` permissions over no diary · The invited address is the address on the provider record and
nothing else

---

# 1. Context

A provider is a **diary**, not a login. That has been the design since Epic 2 and it does not change
here: `Membership.providerId` is nullable in both directions, so the front desk can keep a visiting
hygienist's schedule without that person ever having an account (phase-2-3 §2.8).

What changes is that giving them one stops being two steps on two screens, one of which does not exist:

1. `POST /v1/members/invitations` with `role: "PROVIDER"` — which returns the acceptance link in the
   response body and **emails nothing** (phase-1 §5.1).
2. `PATCH /v1/members/:membershipId { providerId }` — which links the resulting membership to the diary.
   The API has supported it since Epic 2. **No screen has ever called it.**

Skip the second and the result is a member holding `availability:manage:own`, `booking:read:own` and
`booking:manage:own` — three permissions that authorise nothing, because `canForProvider` compares
`membership.providerId` against the resource and an unlinked membership fails closed (phase-1 §3.1).
The person has "joined". They can do nothing at all. Nothing anywhere says why.

That is not a bug in any one place; it is a two-step process with no affordance for the second step. The
fix is to make the second step impossible to omit, which means putting it inside the first.

## 1.1 What this deliberately does not do

- **Generic member invitations are still not emailed.** `POST /v1/members/invitations` continues to
  return the link once, for OWNER, ADMIN and ASSISTANT — it no longer accepts PROVIDER at all (§2.11).
  Phase-1 §5.1 is therefore _partially_ closed, and is deliberately left in that record rather than
  deleted, so the remaining gap does not vanish with the fix.
- **No new home screen.** A provider lands on `/dashboard/availability` — their diary — rather than on a
  purpose-built home with today's appointments. PRD §6.2's persona wants one; it is a separate piece of
  work and naming it here is all this record does about it.
- **No delegation.** A receptionist managing somebody else's diary remains neither built nor designed
  (phase-2-3 §5.9). This work makes the provider's own access real; it does not add a notion of acting
  _for_ another provider. **Since 2026-08-17 it does exist** — see
  [phase-3-4-diary-delegation.md](phase-3-4-diary-delegation.md) — and it builds directly on this record:
  the provider's own access being real is what a grant is defined against.
- **No self-service password reset.** A provider who lets their invitation lapse needs a new one, which
  is the same row action pressed again.

---

# 2. Decisions

## 2.1 The entry point is a row action, so the diary is never ambiguous

The alternative was a `providerId` field on the existing generic invite panel. It was rejected because
it asks the wrong question at the wrong time: the owner is looking at a list of people, and "which of
these diaries does this email address belong to" is a lookup they have to perform in their head. Pressing
**Invite** on Dr. Kovács's row cannot select the wrong diary, because the row _is_ the selection.

It also puts the action where the address already is. Phase-2-3 §2.8 made `email` mandatory on the
provider form specifically because "the invitation that would give them a login" is addressed to it; the
form has been collecting that address for weeks with nothing consuming it.

## 2.2 `Invitation.providerId`, and why `Cascade` rather than Membership's `SetNull`

The column is nullable, because most invitations name a role and nothing else. When it is set, acceptance
writes `Membership.providerId` in the same transaction that burns the token.

The two foreign keys pointing at `providers` now disagree about deletion, deliberately:

| Row                       | On provider delete | Why                                                                                                                                                                                                                                                                             |
| ------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `memberships.provider_id` | `SetNull`          | A membership that loses its provider still carries a person's _access_. Nulling is the conservative act — archiving a diary must not delete somebody's login (phase-2 §3.2).                                                                                                    |
| `invitations.provider_id` | `Cascade`          | An invitation that loses its provider is a promise nobody can keep. Nobody has accepted it, so nothing is lost by deleting it — whereas `SetNull` would silently downgrade a specific promise into a bare `PROVIDER` invitation granting a role over no diary, and tell nobody. |

`Restrict` would be worse than either: it would make the tenant-delete cascade fail, breaking
`pnpm db:discard-organization`.

In practice this is nearly unreachable — rule 11 means providers are archived, not deleted, and the only
hard delete is the tenant cascade that takes the invitation anyway. It is decided here so that the day
somebody adds a real delete, the answer already exists.

## 2.3 One live invitation per diary — the second partial unique index

`invitations_tenant_email_pending_key` already stops two live invitations reaching the same mailbox.
This is the same rule at a different angle:

```sql
CREATE UNIQUE INDEX "invitations_provider_pending_key"
  ON "invitations" ("provider_id")
  WHERE "status" = 'PENDING' AND "provider_id" IS NOT NULL;
```

Without it, two owners each pressing Invite on the same row produce two working links, both promising
the same schedule. The first acceptance wins; the second violates `memberships_provider_id_key` from
inside the acceptance transaction. That is a 409 shown to **the invitee**, caused by something **an
owner** did days earlier and cannot see.

The index converts that into a conflict at invite time, where the person who caused it is the person
reading the error. Rule 14's principle applied to a different resource: the database decides, and the
application's job is to translate the decision, not to attempt it.

Not `(tenant_id, provider_id)` — a provider belongs to exactly one tenant, so the tenant column adds
nothing. `Membership.@@unique([providerId])` is unscoped for the same reason. The redundant
`provider_id IS NOT NULL` is there to keep every generic invitation — most of the table — out of the
index; PostgreSQL already treats NULLs as distinct.

Hand-written, in its own migration, because Prisma cannot express `WHERE`.

## 2.4 The address comes from the provider record, never from the body

`POST /v1/providers/:providerId/invitation` takes **no body at all**. The role is always `PROVIDER` and
the address is always `provider.email`.

This is phase-9-owner-onboarding §2.1's security property moved one layer up. That record protects the
_acceptance_ — the email is read from the invitation row, never the request, so a leaked token cannot be
redeemed at an address of the holder's choosing. The same argument applies to issuance: a route that
accepted an address alongside a provider id would be a way to attach an arbitrary mailbox to a named
diary, and the person doing it would already hold `member:manage`.

An owner with the wrong address on file corrects the provider record first. That is one extra click and
it leaves the correction where anybody can see it.

## 2.5 Re-inviting supersedes; it does not refuse

Pressing Invite a second time means "they never got it" — every time. So the route revokes any live
invitation matching **either** the address **or** the diary, and issues a fresh one. The newest link is
the only one that works.

Matching on both is not belt-and-braces. Correct a provider's email and re-invite, and the _new_ address
is free while the _old_ address's live invitation still points at that diary — which
`invitations_provider_pending_key` would then refuse, for a reason that appears nowhere on screen.

The revoke happens **inside** the same transaction as the create. `MembershipService.invite` does it
outside, and that is a real defect (§7.2): a create that fails leaves the previous invitation `REVOKED`
with no replacement, so the invitee's working link stops working and nobody is told.

Because the button's behaviour differs from what it says, it reads **Resend** when a live invitation
exists for that diary.

## 2.6 `acceptUrl` still comes back, and the UI hides it

The route returns the acceptance URL in its 201, exactly as `POST /v1/members/invitations` and
`PlatformService.provision` already do, even though an email is now sent.

The reason is phase-9-owner-onboarding-emails §1: the worker memoises its email provider at boot, and one
that cannot deliver writes `SKIPPED` rather than a fake `SENT`. In that state — which is the state of
every fresh clone — dropping `acceptUrl` would leave an owner with no recovery path whatsoever, and the
whole feature would appear silently broken.

The mitigation belongs in the UI, not the API. The panel's success state leads with "sent to
<address>", and the link sits inside a collapsed `<details>`. The email is the mechanism; the link is the
escape hatch. The token is still never audited and never logged.

## 2.7 The link is made inside the acceptance transaction

**Read this before touching `claimInvitation`.**

`claimInvitation` now does three things atomically: re-read the provider, upsert the membership with
`providerId`, and mark the invitation `ACCEPTED`. Two properties fall out of that placement, and both are
easy to lose in a refactor that "tidies" the transaction boundary.

**The provider is re-read inside the transaction**, scoped by tenant and with `archivedAt: null`. Between
the email being sent and the link being clicked, the diary may have been archived. Linking to an archived
provider produces a member with `:own` permissions over a row every query excludes — a role that does
nothing, with no error anywhere. The re-read turns that into a 409 naming the situation.

**The diary may have been given to somebody else in the meantime.** `memberships_provider_id_key` throws
from inside the transaction. That is caught and translated to a 409:

> Someone else has already been given this provider's login. Ask the organization for a new invitation.

Deliberately _not_ the uniform "this invitation link is not valid" that covers missing, used and revoked
tokens. That uniformity is a security property — a probe must not learn which of those it hit — and it
does not apply here: the token _was_ valid, and the constraint that failed says nothing about it.

**The invitation stays `PENDING`.** For free, because the `status: ACCEPTED` write rolls back with
everything else — but it is the right outcome and worth stating: the invitee did nothing wrong, and an
owner who unlinks the other member makes the existing link work again with no reissue. There is a test
asserting `status === "PENDING"` after that 409 precisely because it is a property of _where_ the write
sits, which a later change could quietly lose while keeping every other assertion green.

One consequence, stated rather than fixed: on `accept-and-register` the Better Auth user row is created
outside the transaction (phase-9-owner-onboarding §2.4), so a lost race leaves an account with no
membership. The recovery is the one already documented there — re-opening the link takes the "account
already exists" branch to sign-in and the ordinary `/accept`, which will keep returning the same 409
until an owner unlinks. Accepting the membership _without_ the link would be worse: `inviteProvider`
refuses an address that is already a member, so the degraded state would not be recoverable through the
same button.

Acceptance emits `membership.provider_linked` — the **same** audit action the `PATCH` route emits, so
"when did this membership get this diary" stays one grep rather than two.

## 2.8 One new notification type, in the organization's language

`PROVIDER_INVITED`, appended to `NotificationType` (PostgreSQL can only add enum values at the end
without recreating the type) and to `NotificationTypes` in `@bam/notification-engine`. The contract test
in `@bam/db` needs no edit — it goes red if either side is missed, which is the point of having it.

**The locale is the tenant's `defaultLanguage`, not the provider's `languages[]`.** That column means
something else: the schema calls it the subtags "this provider can work in", read on every public
provider list. It answers _can this dentist treat me in German?_, not _what do you read email in?_ A
Hungarian dentist who also speaks German carries `["hu","de"]`; picking `[0]` is right by accident and
picking anything else is wrong.

The codebase already shows what a person's language field looks like — `Customer.preferredLanguage`, fed
to `resolveLocale` as the higher-priority input — and `Provider` has none. Inventing the semantics out of
`languages[]` would be guessing where the model is explicit elsewhere. Recorded as a gap in §7: the
honest fix is a `Provider.preferredLanguage` column, not an overload.

The copy carries four things the owner email does not, or says differently:

- **No password is ever emailed.** Repeated verbatim in spirit from `organization-created`, because a
  recipient expecting one will otherwise write in asking where it is — and because the predecessor
  project emailed plaintext passwords, which is the practice this whole design exists to avoid.
- **Who invited them**, falling back to the organization when the inviter's name is unknown.
- **What they get**, which is not what an owner gets. "Add your services, staff and opening hours" would
  promise exactly the three nav items §2.9 removes. It says: set your working hours, add time off, see
  your own bookings.
- **What to do if this was unexpected.** New relative to the owner email and earned: the address was
  typed by a clinic into a form, so a typo sends this to a stranger.

## 2.9 The nav removes what the caller cannot use — it does not disable it

Until now the only nav gating was the subscription gate, which renders items as `aria-disabled` spans
with a shared explanation (phase-9 §2.11). Permission gating does the opposite and removes them, which
is not an inconsistency:

- The **subscription gate is temporary and the user can resolve it**. Naming the reason is useful, and
  the resolution is one item along in the same nav.
- A **permission they will never hold is not actionable**. An item announcing "you cannot do this" on
  every page load is noise, and there is nothing to click through to.

Both remain advisory. The API re-authorises every request; hiding an item has never been what stops
anything, and this changes nothing server-side.

**A `PROVIDER` ends up with Overview, Bookings and Availability.** Not Subscription (`billing:manage` is
OWNER-only), not Services, Locations or Providers — six clickable links that 403 was the defect
phase-9-owner-onboarding §1.1 named for owners and never fixed for anybody else.

Overview stays ungated. Not because `member:read` makes its members table useful — that is a pleasant
coincidence, not an argument — but because it is the only screen guaranteed reachable: `landingFor()`
sends everyone there, the sign-in redirect lands there, and the accept flow's non-provider button goes
there. An unreachable current page is a worse failure than an item nobody needs.

**An `ASSISTANT` also loses four dead items.** That is outside the stated scope of provider onboarding
and is named here rather than left to arrive as a side effect.

## 2.10 A provider lands on their diary

`accept-invitation.tsx` sends `role === "PROVIDER"` to `/dashboard/availability` and everybody else to
`/dashboard`. Availability is the one part of this system that is theirs (phase-2-3 §2.7) and the thing
the email just asked them to fill in; the overview is a members table.

It stays a **button, not an auto-redirect**. `phase-9-manual-test-checklist.md` B4 asserts the manual
press, and `RegisterForm` calls `router.refresh()` first precisely because the session cookie arrives on
a response the cached session does not know about. Auto-navigating re-opens that race on a screen that
does not currently have it.

Tenant resolution needs nothing new: `tenant-context.plugin.ts` falls back to the caller's sole ACTIVE
membership, which is exactly a new provider's situation — the same fallback added for invited owners in
phase-2-3's postscript.

## 2.11 PROVIDER cannot be invited from the generic panel — added 2026-08-04, after the fact

**This section exists because the first owner to use the feature did not use it.**

Everything above describes the good path. What it did not do was close the bad one. `POST
/v1/members/invitations` still accepted `role: "PROVIDER"`, and the Overview tab's **Invite someone**
panel still offered it in a dropdown — on the landing screen, which is where somebody looking for
"invite" looks first. §1.1 called that panel a known gap and left it, reasoning only about the missing
email. That was the wrong thing to reason about.

What actually happened, within an hour of shipping: an owner invited a provider from Overview. It sent no
email, carried no diary, and created no provider row. She accepted, signed in, and had a dashboard with
`availability:manage:own`, `booking:read:own` and `booking:manage:own` — three permissions matching
nothing, no Availability tab, and nothing anywhere saying why. **Precisely the defect §1 opens with**,
reached by the route this work left untouched.

Two aggravating details, both mine. The owner had archived the only provider row, so the Providers tab was
empty and there was no row to press **Invite** on — the good path was invisible at the moment it was
wanted. And `inviteProvider`'s refusal for an address that is already a member reads _"Link their
membership to this provider instead"_, pointing at a screen that did not exist. The same false signpost
this record corrected in phase-2-3 §2.8, written fresh.

So:

- **The route refuses `PROVIDER`**, with a message naming where it can be done. In the service, not by
  narrowing `INVITABLE_ROLES` — that constant is still true, the role _is_ grantable by invitation, just
  by the route that knows which diary is meant.
- **The dropdown offers OWNER, ADMIN and ASSISTANT**, with a notice linking to Providers.
- **`PATCH /v1/members/:membershipId { role }` still allows it.** Promoting an existing member is a
  different act from inviting a stranger: the person is already here, and whoever promotes them can see
  the diary column in the same table.

### The members table now shows the diary, and can repair one

The recovery for anyone already stranded, and the thing that makes the error message true. The table had
name, email and role — in which a `PROVIDER` holding no diary looks entirely healthy. It now has a
**Diary** column: the provider's name when linked, and when not, a select of unlinked non-archived
providers that calls `PATCH /v1/members/:membershipId { providerId }`.

That endpoint has existed since Epic 2 and no screen has ever called it. §5.11 of phase-2-3 named the
absence; this closes it from the other side.

**It is a repair, not a second front door.** The invitation is still what links a diary for anyone
arriving new. This is for memberships that predate that, or were made by the panel while it still offered
the role — and for the case the invite route refuses by design, where somebody is already a member and
should not be re-invited.

### What this cost

One production-shaped bug found by an owner rather than by the 22 tests, because every one of them
exercised the path being added and none asked what the old path now meant. There are two tests for it now:
the refusal, and that the other roles still work.

---

# 3. API surface

```text
POST /v1/providers/:providerId/invitation    member:manage · writable tenant · 30/hour
     (no body — the address is provider.email and the role is always PROVIDER)
  →  { id, email, role: "PROVIDER", providerId, expiresAt, acceptUrl }

POST /v1/invitations/lookup                  now also returns providerName
GET  /v1/members/invitations                 now also returns providerId
```

**`member:manage`, not `provider:manage`.** Rule 10 says ask for the permission that names what you are
doing. The row this creates is an `Invitation` that grants a `Membership`; the provider is the _object_,
not the thing being changed. OWNER and ADMIN hold both today so nothing behaves differently — the point
is that a future "may configure the catalogue but not hand out logins" role is expressible without
editing this route.

**No `Idempotency-Key`.** Rule 16 is scoped to writes a _customer_ can retry. This is a staff write, and
§2.5's supersede makes a double-submit converge on one live invitation rather than two.

**Failure modes**, each with its own message because each has a different fix:

| Situation                                  | Status                                    | Decided by                                                                          |
| ------------------------------------------ | ----------------------------------------- | ----------------------------------------------------------------------------------- |
| provider absent, other tenant, or archived | 404 `PROVIDER_NOT_FOUND`                  | `findByIdOrThrow` without `includeArchived` — the same answer either way (rule 5)   |
| `provider.email` null or blank             | 422 `VALIDATION_FAILED`, `field: "email"` | legacy rows only; §7.1                                                              |
| that diary already has a login             | 409                                       | pre-check, two messages: _already has a login_ vs _another member holds this diary_ |
| that address is already a member           | 409                                       | points at linking their membership instead                                          |
| a live invitation exists (either key)      | **201**                                   | superseded (§2.5)                                                                   |
| two invites race                           | 409                                       | P2002 on either partial index                                                       |

The service method is `MembershipService.inviteProvider`, **not** an optional `providerId` on `invite()`.
`invite()` is a public route's contract, and an optional diary parameter there would be a second,
undocumented way to reach this feature that no screen uses and no test covers. The route owns the
rule-5 repository lookup; the service owns the token, the hash, the supersede, the outbox and the
transaction — duplicating any of that into `ProviderService` is exactly how `findValidInvitation`'s own
doc comment says these things drift apart.

## 3.1 Fixed in passing

Three defects in files this work opens anyway. Each is named here rather than left to ride silently.

1. **Accept URLs were built by string concatenation** in `membership.routes.ts` and twice in
   `platform.routes.ts` — the exact locale-segment defect
   [phase-9-owner-language-and-return-paths.md](phase-9-owner-language-and-return-paths.md) §2 fixed
   everywhere else, and which CLAUDE.md names `buildAppUrl` as the only remedy for. An English-language
   organization's owner was linked to a Hungarian page.
2. **`MembershipService.invite` revoked outside the transaction it then created in.** A create that
   fails left the previous invitation `REVOKED` with no replacement: the invitee's working link stops
   working and nobody is told. Now one transaction, as `inviteProvider` is.
3. **`membership.test.ts` did not exist**, despite a comment in `membership.routes.ts` claiming it kept
   the literal Zod role enums in step with `@bam/auth`. The comment was false and this work adds a third
   literal. The schemas moved to `membership.schemas.ts` — which tech-impl §6's module layout asks for
   anyway — and the test now exists.

---

# 4. Worker and templates

`OutboxEvent.eventType` is a plain `String`, so `PROVIDER_INVITED` needs no migration. The
`aggregateType` is **`"Provider"`**, which does need a new branch: `dispatchOne` routes `"Tenant"` and
`"Booking"` and debug-logs everything else into a no-op, so without one this event would be silently
swallowed. Claiming `"Tenant"` and hiding the provider id in the payload would have saved one `if` by
lying about what the row is about, which is precisely what `aggregateId` is for when somebody is
debugging at 2am.

⚠️ **The tenant comes from `event.tenantId`, not `aggregateId`.** The Tenant handlers read `aggregateId`
for the tenant; here it is the provider. Copying one of them without changing that is the mistake the
comment in `dispatchProviderEvent` exists to prevent.

The dedupe key is the event id, matching `ORGANIZATION_PROVISIONED` — so a re-invite is a new outbox row
and legitimately earns a second email, which is the whole point of a re-invite.

The sender's `SENT` path already writes `payload: {}`, wiping the accept URL; a provider that cannot
deliver already writes `SKIPPED` **keeping** its payload, because when nothing was sent the token in that
column is the only copy anyone has (phase-9-owner-onboarding-emails §2). Neither needed changing.

---

# 5. Web

| Piece                                        | Where                   |
| -------------------------------------------- | ----------------------- |
| Invite / Resend row action and its panel     | `providers-screen.tsx`  |
| Provider landing (`/dashboard/availability`) | `accept-invitation.tsx` |
| Permission-driven nav filtering              | `dashboard-shell.tsx`   |
| `catalogue` and `invitation` copy, hu + en   | `messages/{en,hu}.json` |

The panel is a third `useEditPanel`, alongside `edit` and `assignments`, so it inherits the focus wiring,
the `aria-expanded`/`aria-controls` pairing and the scroll behaviour. There is no Dialog primitive on
this screen and it is not getting one.

A legacy row with no email renders the button `aria-disabled` rather than `disabled`, with one shared
hint node under the table — a keyboard user must still be able to reach it and hear why. Same reasoning
as the nav's subscription gate.

The nav's permission literals are strings, not `Permissions.*`: `@bam/auth` is not a dependency of
`apps/web` and every existing call site uses a literal. Adding the dependency for six strings was not
worth the build edge; the risk that a typo silently hides an item is recorded in §7.

---

# 6. Verification

```bash
pnpm db:migrate && pnpm db:drift-check
pnpm lint && pnpm check-types && pnpm test
```

## 6.1 What was built

| Piece                                                        | Where                                                         |
| ------------------------------------------------------------ | ------------------------------------------------------------- |
| `Invitation.providerId` + FK + index                         | migration `20260804114159_invitation_provider_id`             |
| One live invitation per diary                                | migration `20260804114223_invitation_provider_pending_unique` |
| `MembershipService.inviteProvider`                           | `membership.service.ts`                                       |
| `claimInvitation` carrying the link, and the race translated | `membership.service.ts`                                       |
| `describeInvitation` naming the diary                        | `membership.service.ts`                                       |
| `POST /v1/providers/:providerId/invitation`                  | `provider.routes.ts`                                          |
| Role schemas lifted out, and the test that was promised      | `membership.schemas.ts`, `membership.test.ts`                 |
| `dispatchProviderEvent`                                      | `outbox.dispatcher.ts`                                        |
| `renderProviderInvited`, hu + en                             | `templates.ts`                                                |
| Invite / Resend row action and panel                         | `providers-screen.tsx`                                        |
| The provider's landing, and the diary named on the form      | `accept-invitation.tsx`                                       |
| Permission-driven navigation                                 | `dashboard-shell.tsx`                                         |
| PROVIDER refused on the generic invite route (§2.11)         | `membership.service.ts`                                       |
| Diary column and the link repair on the members table        | `dashboard.tsx`                                               |
| 22 integration tests                                         | `apps/api/src/provider-onboarding.test.ts`                    |
| Dispatcher, sender and template tests                        | worker and engine suites                                      |

## 6.2 Deviations from the plan

- **Two migrations, not three.** The `PROVIDER_INVITED` enum value was meant to travel alone, because
  `ALTER TYPE … ADD VALUE` cannot be _used_ by a later statement in the same transaction. It landed with the
  column instead, which is safe — nothing in that migration uses the value — and splitting it after it had
  applied would have broken its checksum for no gain. The rule still holds for the next person: a migration
  that adds an enum value and then writes a row with it will fail.
- **`buildDedupeKey` and `TEMPLATES` both needed a case.** Neither was in the plan and both are the reason
  the plan did not need to be: `DedupeInput` is a discriminated union and `TEMPLATES` is a
  `Record<NotificationType, string>`, so adding a notification type without deciding its dedupe grain and its
  template name is a compile error rather than a runtime surprise. Exactly what those shapes are for.
- **`apps/worker`'s test files now run one at a time.** `dispatchOutboxBatch` claims across every tenant, so
  the dispatcher suite empties the outbox to get exclusivity — which works only while nothing else writes.
  Run concurrently, `stripe.processor.test.ts` inserts mid-batch and the claim counts come out high. A latent
  race, not a new one: it needed only a slower dispatcher file to surface, which this work's tests supplied.
  `fileParallelism: false` in `apps/worker/vitest.config.ts`, with the reasoning beside it.
- **Two wrong route names and a false claim were corrected in phase-2-3 §2.8**, which named
  `POST /v1/tenants/:id/invitations` and `PATCH /v1/memberships/:id` — neither exists — and said the invite
  "does send an email", which was not true of any invitation at the time.

## 6.3 Results — 2026-08-04

| Check                           | Result                                                        |
| ------------------------------- | ------------------------------------------------------------- |
| `pnpm db:drift-check`           | no drift; the committed migrations reproduce `schema.prisma`  |
| `apps/api`                      | 248 passed, 23 of them new (20 integration + 3 schema-parity) |
| `apps/worker`                   | 62 passed, 9 of them new (5 dispatcher + 4 sender)            |
| `@bam/notification-engine`      | 104 passed, 7 of them new                                     |
| `pnpm lint && pnpm check-types` | clean across all 19 tasks                                     |

Two things worth knowing about that run:

- **The race test prints a `prisma:error` and passes.** That is the unique index doing its job and the catch
  translating it; Prisma logs the violation before the code sees it. A silent run of that test would mean the
  constraint never fired.
- **`vitest` does not typecheck.** The dispatcher tests passed while `pnpm check-types` failed on a
  `Record<string, unknown>` payload Prisma's JSON input refuses. Run both.

The manual walk is **§M** of [phase-9-manual-test-checklist.md](phase-9-manual-test-checklist.md) and has
**not** been done.

---

# 7. Deviations and known gaps

1. **`Provider.email` is still a nullable column.** Both write schemas have required it since phase-2-3
   §2.8, so no new null can appear, but rows created before then may hold one — and now that has a
   user-visible consequence: the Invite button is disabled for them. That gives the backfill a reason it
   did not have when phase-2-3 §5.10 recorded it.
2. **A provider who does not read the organization's language gets it anyway** (§2.8). The honest fix is
   a `Provider.preferredLanguage` column mirroring `Customer.preferredLanguage`, not an overload of
   `languages[]`.
3. **Generic member invitations are still not emailed** (§1.1). Phase-1 §5.1 stays open for them.
4. **Neither invite path checks `canHoldTenantMembership`.** A platform admin's address can be invited
   and only discovers the refusal at acceptance. `PlatformService.assertOwnerMayHoldMembership` is the
   only invite-time check today; this work is consistent with that rather than extending the asymmetry,
   and names it here so it reads as pending rather than decided.
5. **The nav filter is advisory and drifts silently.** A typo in a permission literal hides a nav item
   with no error anywhere. The mitigation would be a unit test asserting every literal in `NAV` appears
   in `Object.values(Permissions)`, which needs `@bam/auth` as a web dependency (§5).
6. ~~**Delegating a provider's availability is still neither built nor designed**~~ — **closed 2026-08-17
   by [phase-3-4-diary-delegation.md](phase-3-4-diary-delegation.md)**, which also narrows `ASSISTANT` from
   clinic-wide bookings to delegated ones. Note the consequence for §2.9's nav table: an ASSISTANT now
   reaches Bookings through `booking:read:delegated` and can gain Availability through a grant.
7. **No provider home screen** (§1.1). PRD §6.2 wants one.
8. **PRD §9.3 still declares `userId?: string` on `Provider`.** The pointer has lived on
   `Membership.providerId` since Epic 2 — the direction was reversed so that a diary can exist without a
   login and a person can hold one membership per organization. Recorded here because it was never
   recorded anywhere.
