This is the manual verification checklist for diary delegation. It closes §8.4 of
[phase-3-4-diary-delegation.md](phase-3-4-diary-delegation.md), which is the design this walk exists to
validate — read its §2.1, §2.3, §2.12 and §2.13 first.

# Phases 3–4 — Diary delegation manual test checklist

**Document version:** 1.0 — written 2026-08-17. **Not yet walked.**
**Covers:** the Delegates panel → assigning, inviting by email, re-scoping → the two scopes kept apart →
navigation → revocation → lifecycle → tenant isolation → localization and accessibility → the audit trail.
**Note the model:** the **owner** staffs every diary; the **provider** only reads who assists them; the
**admin is out entirely**. Record §2.3.

---

# 1. What this walk is for

The automated suite covers the *rules* thoroughly: 65 assertions in `policy.test.ts` over the pure policy
functions, 25 in `delegation.test.ts` over real HTTP, 10 over the web scope helper, 7 over the navigation,
and the email template in both locales. Repeating those by hand is wasted effort.

**What no test in this repository can tell you** is on the following list, and it is the reason to walk it:

1. **Whether the screens read correctly to a person who did not write them.** Three empty states
   ("no diaries have been delegated to you yet", "nobody manages this diary but the provider", "there is
   nobody left to add") each say a different thing about a different problem, and each is the only guidance
   a stuck user gets.
2. **Whether the front desk's day still works.** Every automated assertion is one request. Nobody has sat
   in front of this and tried to run a reception desk with it.
3. **Whether the empty Delegates panel is noticed at all.** §6.5's day-2 trap is mitigated by a callout
   whose whole job is to be seen; a test can assert it renders and not that it works.
4. **Whether a delegate can tell whose diary they are looking at.** Two providers, one picker, and a
   mis-read means somebody's Tuesday gets deleted.

## 1.1 What is already proved, and need not be re-done by hand

Skip these unless something else looks wrong — each is asserted and would fail CI:

- neither a delegate, a provider nor an admin can staff a diary (`delegation.test.ts`)
- accepting an invitation writes the membership and the assignment, or neither
- a grant in tenant A decides nothing in tenant B (both suites)
- an ungranted assistant is refused rather than shown an empty page
- a BOOKINGS grant cannot write availability and an AVAILABILITY grant cannot read bookings
- revocation takes effect on the next request
- `customerName` is null for an availability-only delegate
- the exact nav for each role, including the two empty-handed cases

---

# 2. Preconditions

| Thing | State | Note |
| --- | --- | --- |
| `pnpm dev` | running | 3 apps + a `tsc --watch` per library |
| Database | migrated | five migrations, `..101441_provider_delegations` through `..160500_drop_delegated_diary_pending_index` |
| An organization | **`ACTIVE` or `TRIAL`** | see the warning below — this is the one that will waste an hour |
| Worker | **running** | §B2 sends a real email through it. Everything else works without it |
| `RESEND_API_KEY`, `EMAIL_FROM` | set, **and the worker restarted since** | it memoises its email provider at boot (phase-9-owner-onboarding-emails §2) |

> ### The organization must accept writes
>
> `tenantAcceptsWrites` is an allow-list of `ACTIVE` and `TRIAL` (policy.ts). Provisioning through
> `/admin/platform` creates a tenant in **`PENDING_SUBSCRIPTION`**, and every write below — creating a
> provider, saving hours, granting a diary — is refused by `requireWritableTenant` before any delegation
> logic runs. The failure looks like a permissions bug and is not one.
>
> Either walk [phase-9-manual-test-checklist.md](phase-9-manual-test-checklist.md) §D–F first to subscribe
> properly, or, if billing is not what you are testing today, set the status directly:
>
> ```sql
> UPDATE tenants SET status = 'TRIAL' WHERE slug = '<your-slug>';
> ```

**One invitation here does send email** — the assistant invitation in §B2, which is why this slice exists.
Everything else notifies nobody: assigning an existing member to a diary tells them nothing (§K4). If the
keys are unset the invitation still succeeds and shows its link, so the walk continues either way; only
§BB3 and §BB4 need a real inbox.

**Four browser profiles**, or one plus three private windows. You will be five people: the owner, an admin,
a provider, and two assistants. Signing in and out repeatedly is the slow way to walk this.

## 2.1 The shortcut that makes this walk feasible

`pnpm db:join-tenant` skips the invitation dance. Development only; it refuses to run with
`NODE_ENV=production`.

```bash
# The person must already have an account — sign them up in the app first.
pnpm db:join-tenant reka@example.test  <slug> ASSISTANT
pnpm db:join-tenant eva@example.test   <slug> ASSISTANT
pnpm db:join-tenant kata@example.test  <slug> ADMIN
pnpm db:join-tenant anna@example.test  <slug> PROVIDER --provider "Dr. Kovács Anna"
```

The `--provider` flag is what makes the `:own` paths real: a PROVIDER whose membership names no diary is
refused everywhere, by design, and is its own test case (§F6).

Do **not** use it for §B2's newcomer: inviting somebody who has no account is the path this slice added,
and the shortcut would skip exactly what needs testing.

---

# 3. Setup

Sign in as the owner and build this. It takes about five minutes and everything below assumes it.

- [ ] **S1** One service, 60 minutes, no approval required.
- [ ] **S2** One location.
- [ ] **S3** **Two** providers — call them **Anna** and **Béla**. Two is not optional: almost every check
      below is "the granted diary and *not* the other one", and one provider cannot show that.
- [ ] **S4** Both offer the service and work at the location.
- [ ] **S5** Both have working hours on the same weekday, 09:00–17:00.
- [ ] **S6** One confirmed booking on Anna at 09:00 and one on Béla at 10:00, on that weekday. Use the
      public booking page or Bookings → New. **Give the customers distinguishable names** — the redaction
      check in §D4 turns on being able to see whether a name is there.
- [ ] **S7** Two assistant accounts (**Réka**, **Éva**), one provider account linked to Anna's diary, and
      **one ADMIN account** — the admin exists purely to prove they can do none of this (§A7, §G3).
- [ ] **S8** One email address that has **never** been used, for §B2. A real inbox you can open, because
      §BB3 is about an email actually arriving.

---

# 4. The checklist

## A. The Delegates panel — where it is and who sees it

- [ ] **A1** As the owner: Providers → Anna's row → the availability link. The URL carries `?providerId=`.
- [ ] **A2** The page shows **three** panels in order: Working hours, Exceptions, **Delegates**. Delegates
      last, because it is the least frequent thing anyone does here.
- [ ] **A3** With nobody assigned the panel shows the action-toned callout: *"Nobody manages this diary but
      the provider. Front-desk staff cannot see its bookings until somebody is added here."* **Read it as a
      stranger.** It is the whole mitigation for the day-2 trap (record §6.5), and if it does not prompt
      anybody to act, that trap is still open.
- [ ] **A4** As the **provider** (Anna's account): `/dashboard/availability` with no query string lands on
      her own diary and the Delegates panel is there — **as a list, with no controls at all**. No Assign, no
      Invite, no checkboxes, no Revoke. Her empty state is the other one: *"Nobody assists on your diary yet.
      Ask the organization owner…"*, because she cannot fix it herself.
- [ ] **A5** As the provider, the scope column is **plain text**, not disabled checkboxes. A disabled control
      invites the reader to work out how to enable it.
- [ ] **A6** As the provider, try `/dashboard/availability?providerId=<béla>` by hand → the working-hours
      panel refuses, and no Delegates panel for a colleague's diary.
- [ ] **A7** ★ As an **ADMIN**: the Delegates panel is **absent entirely**, on every diary — even though they
      can edit every schedule in the clinic. This is the check most likely to have been broken by somebody
      reading the ADMIN permission row and seeing a gap (record §2.3).
- [ ] **A8** As an assistant **who has been assigned this diary** (after §B): the panel is **absent**. A
      delegate cannot pass a diary on, and cannot enumerate the others either.
- [ ] **A9** As the owner, switch the picker to Béla. The panel follows: Béla's assistants, not Anna's.

### A10–A14 — the Providers row action (record §2.10.1)

Added 2026-08-18. The availability screen is the *provider's* route to the panel; this is the **owner's**,
and it is the one an owner actually finds. Everything in §B and §H works identically from here, so walk §B
from whichever entry point you prefer — but walk these five once.

- [ ] **A10** As the owner: Providers → Anna's row shows **Manage assistant** between Deactivate and Archive.
      Pressing it opens the same Delegates panel below the table, titled *"Assistants for Dr …"* — the name
      matters, because the table has several rows and the panel is one.
- [ ] **A11** ★ As an **ADMIN**: the row action is **absent**, while Edit, Assign, Availability, Deactivate
      and Archive are all still there. Same reason as A7, and this is the easier one to get wrong — every
      other button in that cell is `provider:manage`, and this one deliberately is not.
- [ ] **A12** Press **Manage assistant** on Anna, then on Béla without closing. The panel switches diaries and
      any half-filled email box is **cleared**, not carried across.
- [ ] **A13** **Close** returns focus to the row button you pressed, and the button reads `aria-expanded`
      correctly to a screen reader. Same contract as Edit and Assign — it is the same hook.
- [ ] **A14** An **archived** provider's row offers only Restore, so no Manage assistant. Existing grants on
      an archived diary survive and keep working (record §2.8); this is only about not offering new ones.

## B. Assigning and inviting

- [ ] **B1** As the owner on Anna's availability screen there are **two** buttons: **Add a delegate** (an
      existing member) and **Invite someone new** (an email address). Both lead to the same scope
      checkboxes.
- [ ] **B2** _Add a delegate._ The select lists members who are already in the organization and can hold a
      diary.
- [ ] **B3** **It does not list the owner, any admin, or Anna's own login.** Owners and admins cannot receive
      a diary; Anna already holds `:own` over it. A picker that offered them and then refused would be the
      defect the candidates endpoint exists to prevent.
- [ ] **B4** The two scopes each carry a hint line — "Set working hours and book out time off on this diary"
      and "See, accept, reschedule and cancel this diary's appointments". **Read both.** They are the only
      place anybody is told what is being handed over.
- [ ] **B5** Untick both scopes → the submit button is disabled. An empty grant is a revocation wearing a
      grant's clothes, and the database refuses it outright.
- [ ] **B6** Assign somebody **Bookings** only. The row appears with Bookings ticked and Availability clear.
- [ ] **B7** Tick **Availability** on that row. It saves in place — no dialog, no second form.
- [ ] **B8** Untick both on an existing row → refused with *"A delegate needs at least one of the two. Use
      Revoke to remove their access entirely."* and the row is unchanged. The destructive act has to be
      named.
- [ ] **B9** Assign a second person to the same diary. **Two assistants on one diary** is the normal case.
- [ ] **B10** Assign the first person **Béla's** diary too. **One assistant, several providers** — the
      headline requirement, and §E is where it pays off.

## B2. Inviting somebody with no account ★

This is the path that fixes the two-screens-and-no-email problem, and the one with the most to go wrong.

- [ ] **BB1** **Invite someone new** → an email address that has never been seen → both scopes → Send.
- [ ] **BB2** The confirmation shows the accept link **once**, with "Copy it now — it is shown only once."
      The link is the fallback; the email is the affordance.
- [ ] **BB3** ★ **An email actually arrives.** This is the whole point of the change. If it does not, check
      the worker is running and that it was restarted after `RESEND_API_KEY` was set — the worker memoises
      its email provider at boot (phase-9-owner-onboarding-emails §2). Then check the outbox row exists:
      `select * from outbox_events where event_type = 'ASSISTANT_INVITED';`
- [ ] **BB4** The email **names the provider** they are being asked to assist, and does **not** greet them as
      that provider. It also lists what the invitation covers, matching the scopes you ticked.
- [ ] **BB5** Open the link in a private window → set a name and password → accept. They land signed in.
- [ ] **BB6** ★ **Both rows exist, or neither.** In the database: an ACTIVE `ASSISTANT` membership *and* a
      `provider_delegations` row for that diary with the right scopes. An assistant with a membership and no
      assignment sees nothing at all and looks exactly like a permissions bug (record §2.13).
- [ ] **BB7** Their nav immediately reflects the scopes — Bookings, Availability, or both.
- [ ] **BB8** Reopen the same link → "This invitation link is not valid."
- [ ] **BB9** Invite somebody who is **already a member** → refused with *"That person is already a member.
      Assign them from the list instead of inviting them."* Not silently converted into an assignment.
- [ ] **BB10** Invite the same new address again for the **same** diary → the first link stops working and
      only the newest is live.
- [ ] **BB11** _The rule that surprised the implementation._ Invite the same new address for **Béla's** diary
      while an invitation for Anna's is still pending → it succeeds, and it **supersedes** the first: exactly
      one live invitation per address per tenant, which has been true since Epic 1 (record §2.13.2). To give
      one person two diaries, let them accept one and then **assign** the second.
- [ ] **BB12** Archive a provider, then try to invite an assistant for them → refused.
- [ ] **BB13** As an **ADMIN**, and as the **provider**, call the invitation endpoint directly (devtools or
      curl) → 403 for both.

## C. A BOOKINGS grant, and only bookings

Réka holds Bookings on Anna. Sign in as her.

- [ ] **C1** Nav shows Overview and **Bookings**. **No Availability item** — she holds
      `availability:manage:delegated` but no AVAILABILITY grant, and a link that 403s is worse than an
      absent one (record §6.3).
- [ ] **C2** Bookings lists Anna's 09:00 appointment. **Béla's 10:00 is not there** — revoke the Béla grant
      from §B10 first if you already made it, or this check proves nothing.
- [ ] **C3** She can accept, complete, mark no-show and cancel Anna's booking. This is the front desk's
      actual job; do it, do not just look at the buttons.
- [ ] **C4** Type `/dashboard/availability?providerId=<anna>` by hand. The screen loads — the nav is
      advisory — and the working-hours panel reports an error rather than rendering Anna's week. **The read
      is refused, not only the write** (record §2.9).

## D. An AVAILABILITY grant, and the redaction

Give Éva **Availability only** on Anna. Sign in as her.

- [ ] **D1** Nav shows Overview and **Availability**. **No Bookings item.**
- [ ] **D2** She can edit Anna's working hours and add a closure. The panels behave exactly as they do for
      Anna herself.
- [ ] **D3** `/dashboard/bookings` by hand → the list is refused.
- [ ] **D4** ★ **The check this feature's worst bug hides behind.** As Éva, change Anna's hours to start at
      10:00 — stranding the 09:00 booking. The affected-bookings dialog appears. **It must list the
      appointment with its time, service and reference, and with no customer name.**
- [ ] **D5** The dialog is still *usable* without the name — you can tell which appointment it means and
      decide. If it is not, the redaction is too aggressive and §2.12 needs revisiting.
- [ ] **D6** Confirm the same save as the **owner**: the identical dialog **does** show the customer's name.
      Same screen, same action, different reader — that is the whole point.
- [ ] **D7** Acknowledge and save as Éva. The change lands, and the stranded booking is still there with its
      "outside schedule" marking on the Bookings screen (visible to the owner).

## E. Several diaries, one assistant

Restore Réka's grants: Bookings on **both** Anna and Béla.

- [ ] **E1** Bookings shows a provider filter. Its "all" option reads **"All my providers"**, not
      "Everyone" — she is not seeing everyone, and the copy must not claim she is.
- [ ] **E2** With no filter, the list is Anna's and Béla's appointments and nothing else. Add a third
      provider with a booking to prove the exclusion properly.
- [ ] **E3** The filter offers **only** Anna and Béla, not the third provider.
- [ ] **E4** Give her Availability on both as well. The availability screen now shows a **provider picker**.
      Switch between the two diaries and confirm the working hours change with it — this is where a
      mis-labelled picker deletes the wrong person's Tuesday.
- [ ] **E5** With a grant on exactly **one** diary, the picker does not render at all and the screen goes
      straight to it. No pointless select with one option.

## F. Navigation and empty states

- [ ] **F1** A **brand-new assistant with no grants**: nav is **Overview only**.
- [ ] **F2** `/dashboard/bookings` by hand → the screen loads and the list is refused. Advisory, as
      designed — note whether the refusal reads like a bug to a normal user.
- [ ] **F3** `/dashboard/availability` by hand → *"No diaries have been delegated to you yet. A provider can
      hand you theirs from their own availability screen."* **Not** the "your account is not linked to a
      provider" message, which would send them after the wrong thing.
- [ ] **F4** As the **owner**: still **no** top-level Availability item. It belongs to a provider, and an
      owner reaches one at a time from the Providers row (phase-2-3 §2.7). This is the check most likely to
      have been broken by accident.
- [ ] **F5** As the owner: Bookings **is** present — the whole organization's day is genuinely their screen.
- [ ] **F6** A **PROVIDER whose membership names no diary** (`db:join-tenant` without `--provider`): nav is
      Overview only. Neither `:own` permission matches anything.
- [ ] **F7** As an ASSISTANT: no Services, Locations, Providers or Subscription anywhere.

## G. Who cannot staff a diary

- [ ] **G1** As an assistant holding **both** scopes on Anna: no Delegates panel (§A8).
- [ ] **G2** As the **provider**: the panel is a list with no controls (§A4).
- [ ] **G3** As an **ADMIN**: no panel at all (§A7).
- [ ] **G4** With devtools, as each of those three in turn, send
      `PUT /v1/providers/<anna>/delegations/<some membership>` with a scopes body → **403 every time**. The
      UI absence is an affordance; this is the enforcement, and it is one permission rather than three
      special cases (record §2.3).

## H. Revocation

- [ ] **H1** As the owner, revoke Réka's grant on Anna. A confirmation names her.
- [ ] **H2** In Réka's **already-open session**, click into Bookings again. Access is gone **without her
      signing out or the page being reloaded from scratch**. There is no cache to wait out (record §2.7).
- [ ] **H3** Her nav loses the Bookings item on the next full load.
- [ ] **H4** The row is gone from the Delegates panel — not greyed, not "revoked". A hard delete (§2.7).

## I. Lifecycle

- [ ] **I1** _Suspension._ Set Réka's membership to `SUSPENDED` (Overview → members, or by hand). She is
      locked out of the tenant entirely. Reactivate → **her grants still work.** The rows survived, so
      un-suspending restores the provider's configuration rather than silently discarding it (§2.8).
- [ ] **I2** _Role change._ Change Réka to ADMIN and back to ASSISTANT. Her old grants are live again.
      **This is deliberate and is the most surprising behaviour in the feature** (§2.8) — confirm you agree
      with it while looking at it, because the alternative is an admin's temporary role change destroying
      the provider's decision.
- [ ] **I3** With Réka on a role that cannot receive diaries, the Delegates panel labels her row *"Role no
      longer accepts diaries"*. The stale state is visible where it can be fixed.
- [ ] **I4** _Archiving._ Archive Béla (Providers → Delete). Réka's grant on him survives and she can still
      reach his bookings — an archived diary still owns appointments somebody has to cancel.
- [ ] **I5** Restore Béla. Nothing needed re-granting.
- [ ] **I6** _Removal._ Remove a delegate's membership entirely → their grants vanish with it. Check the
      Delegates panel, not just the absence of an error.

## J. Isolation and the audit trail

- [ ] **J1** Provision a **second** organization and make Réka an ASSISTANT there too, with **no** grants.
- [ ] **J2** Switch tenants with the header switcher. In the second organization she reaches nothing; in the
      first her grants are intact. One person, two memberships, two independent sets (§2.4).
- [ ] **J3** `select action, entity_type, entity_id, before_json, after_json from audit_logs where
      entity_type = 'ProviderDelegation' order by created_at;` — a `delegation.granted` then a
      `delegation.rescoped` for a re-scope, and a `delegation.revoked` for each revoke.
- [ ] **J4** ★ **No email address or member name appears anywhere in those rows** — ids only. The audit
      scrubber does not cover a member's details and these rows live for twelve months (rule 6).

## K. Localization, accessibility, and the things only a person notices

- [ ] **K1** Every screen above in **Hungarian** (the unprefixed default) and in **English** under `/en`.
      No key paths rendering as literal text — that is what a missing key looks like.
- [ ] **K2** The Delegates table with a keyboard alone: tab to a scope checkbox, toggle it with space, tab
      to Revoke, activate it with Enter. The scope checkboxes are the control doing real work here.
- [ ] **K3** With a screen reader, the Delegates table is announced with its caption and the scope
      checkboxes with their labels — "Availability" and "Bookings" alone are ambiguous out of context.
- [ ] **K4** _Nobody is told._ A grant emails no one, and neither does a revocation. Réka finds out she has
      Anna's diary by noticing a new nav item. Decide whether that is acceptable; it is not recorded as a
      decision anywhere, which means it was not one.
- [ ] **K5** Dark mode on the Delegates panel — the warning badge in particular.
- [ ] **K6** Narrow the window to a phone width. The Delegates table scrolls inside its own container rather
      than pushing the page sideways.

---

# 5. What to do with the results

Record them in [phase-3-4-diary-delegation.md](phase-3-4-diary-delegation.md) §8.3 and §8.4, and anything
that turns out to be wrong in §9.

**Three to watch.** §BB3 — an email actually arriving — is the whole reason this slice exists, and it
depends on a worker that was restarted after the Resend key was set. §BB6 is the invariant the acceptance
transaction is built around: both rows or neither, because an assistant with a membership and no assignment
looks exactly like a permissions bug. And §A3 is still the only thing standing between this design and its
known day-2 trap.

**§K4 is now half-answered.** An invited assistant *is* told, by email. Somebody assigned from the existing
member list is still told nothing — they find out by noticing a new nav item. Decide whether that asymmetry
is acceptable while you are looking at both.
