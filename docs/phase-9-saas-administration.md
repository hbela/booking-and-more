This began as the **plan** for Epic 9, derived from PRD.md §"Phase 5 — Commercial SaaS features" and
technical-implementation.md §44 (Epic 9). It is now **part plan, part record**: provisioning, the invitation
and its email exist; billing does not. §1.2 is the authority on which is which.

# Phase 9 — SaaS Administration

## Implementation Plan

**Document version:** 0.4 — part record. Provisioning and the owner's invitation email are built (§1.2);
Stripe, the pending dashboard and the expiry sweep are not.
**Scope:** Epic 9 — onboarding, Stripe subscriptions, the activation gate, tenant expiry and suspension, and
the platform-admin dashboard.
**Depends on:** [phase-5-notifications.md](phase-5-notifications.md). Part 1 (outbox dispatch, queues, the
notification record) and enough of part 2 to deliver mail (the provider interface, the sender, the
`notifications` consumer) are in place, which is why `ORGANIZATION_CREATED` can already be sent. The
scheduled warnings in §6 still wait on part 3.
**Exit criteria (epic, per tech-impl §44):** Voice usage can be limited per tenant · Suspended tenants
cannot accept new bookings · Owners can view monthly usage
**Additional exit criteria implied by the flow:** An unsubscribed organization cannot be configured · An
organization that never subscribes is discarded automatically · Provisioning and webhook handling are
idempotent · No password is ever emailed

---

# 1. Context

The commercial model is **sold, not self-served**. Stated by the product owner on 2026-07-29 and simplified
the same day:

1. The platform admin creates an **idle** organization for a prospective owner.
2. The owner logs in and is taken to subscribe.
3. On subscription, the owner becomes **authorized to configure** — services, providers, locations.
4. The platform-admin dashboard's subscription list updates from a Stripe webhook.
5. If no subscription arrives within a window (~2 weeks), the organization is discarded.

The owner then manages their own subscription through Stripe.

## 1.1 Why this version is materially simpler

Version 0.1 of this plan had the subscription preceding the organization, which forced a pre-tenant entity
(an `Offer`) to hold the Stripe customer, because there was no `tenantId` to key it to. That entity carried
its own lifecycle, its own state machine, and a conversion step that could fail halfway.

Creating the tenant first deletes all of it. Stripe's customer keys directly to `tenantId`, the tenant row
_is_ the record of the prospect from the beginning, and there is no conversion to get wrong. The sales offer
becomes an ordinary email sent by a human — not a system entity.

What the simplification costs is one new question, addressed in §2.4: an organization now exists before it
is paid for, so something has to stop it being _used_ before it is paid for.

## 1.2 What is built, as of 2026-07-30

Steps 1 and 2 of §1 work end to end. Step 3 onwards does not.

| Step                                    | State                                       | Where                                                                               |
| --------------------------------------- | ------------------------------------------- | ----------------------------------------------------------------------------------- |
| `PENDING_SUBSCRIPTION`, `subscribe_by`  | **built**                                   | `schema.prisma`, migration `…_platform_administration_and_billing`                  |
| `Subscription`, `stripe_events` tables  | **built**                                   | same migration — tables only, no code reads them                                    |
| `requirePlatformAdmin`                  | **built**                                   | `authorization.plugin.ts`                                                           |
| Provisioning, both modes                | **built**                                   | `platform.service.ts` `provision`                                                   |
| Resend the owner's invitation           | **built**                                   | `platform.service.ts` `resendInvitation`                                            |
| List / suspend / reactivate             | **built**                                   | `platform.routes.ts`                                                                |
| The write gate refusing pending tenants | **built**                                   | `tenantAcceptsWrites`, asserted in `policy.test.ts`                                 |
| The owner's invitation **email**        | **built, untested against a real provider** | `outbox.dispatcher.ts` `dispatchTenantEvent`, `organization-created` template       |
| Platform-admin dashboard                | **built**                                   | `platform-screen.tsx`, `/platform`                                                  |
| Accept-and-register, and the lookup     | **built**                                   | `membership.routes.ts`; [phase-9-owner-onboarding.md](phase-9-owner-onboarding.md)  |
| The invitation landing page             | **built**                                   | `accept-invitation.tsx` — three arrivals, one screen                                |
| `pnpm db:discard-organization`          | **built** (development only)                | `packages/db/scripts/discard-organization.ts`                                       |
| The pending owner dashboard             | **built**                                   | `dashboard-shell.tsx` (gated nav), `dashboard.tsx` (`PendingPanel`)                 |
| Subscribe, webhook, activation          | **built**                                   | `modules/billing/`, `apps/worker/src/stripe/` — a Payment Link, not Checkout (§5.1) |
| The customer portal                     | **built, not yet walked against Stripe**    | `POST /v1/billing/portal`; [phase-9-customer-portal.md](phase-9-customer-portal.md) |
| Trial, plan changes, dunning            | **built, not yet walked against Stripe**    | [phase-9-subscription-lifecycle.md](phase-9-subscription-lifecycle.md) — 30-day trial, once per organization |
| Manual activation (§5.1 D3)             | **not built**                               | still wanted: the permanent bank-transfer path                                      |
| The expiry sweep                        | **not built**                               | nothing reads `subscribe_by`                                                        |
| Removing self-serve `POST /v1/tenants`  | **not done**                                | §2.10 — still live, still called by `dashboard.tsx`                                 |

Two details of the built path are worth stating because they are not obvious from the plan:

- **The outbox event is named `ORGANIZATION_PROVISIONED`; the notification it produces is
  `ORGANIZATION_CREATED`.** Deliberate, and the naming carries the distinction: the event records what the
  platform admin did, the notification records what the owner is told. `planNotifications` does not
  recognise the event — it plans from booking facts only — so `dispatchTenantEvent` handles it on its own
  branch. Adding the type to `OutboxEventTypes` would imply the planner handles it, and it does not.
- **Without `RESEND_API_KEY` the logging provider writes the whole message, accept URL included, to the
  worker log.** That is the local test path for this flow, and the only reason it is safe is that the
  provider is never selected when a key is set.

The remaining contradiction is `POST /v1/tenants`: any signed-in user creates an organization and becomes
its OWNER, rate-limited to five an hour and otherwise unlimited and free. Under this model it is a way to
obtain the product without paying for it (§2.10). It has outlived the plan that said to delete it, which is
the usual fate of a route nobody is blocked by.

## 1.3 The distinction that keeps CLAUDE.md rule 9 intact

Rule 9 says a platform admin holds no memberships, and step 1 has the platform admin creating organizations.
Not a contradiction — these are two different operations:

| Operation           | Who calls it   | Caller becomes OWNER? | Exists                      |
| ------------------- | -------------- | --------------------- | --------------------------- |
| Self-serve creation | any user       | yes                   | yes — to be removed (§2.10) |
| **Provisioning**    | platform admin | **no** — someone else | yes                         |

Provisioning creates a tenant and grants OWNER to a _different_ user. The platform admin takes no
membership, so the separation-of-duties rule holds unchanged.

## 1.4 The flow, step by step, as the code runs it

`→` is a step that works today; `⊘` is one that does not exist yet.

```text
→ 1  A human sells. No system involvement; the offer is an ordinary email (§1).

→ 2  POST /v1/platform/organizations   {name, slug, domain, ownerEmail, ownerName, mode}
     requirePlatformAdmin — the user flag, not a permission, because can() is true
     for a platform admin everywhere and would pass for any owner.
     One transaction (platform.service.ts provision):
       tenant           status = PENDING_SUBSCRIPTION, subscribe_by = now + 14d
       invitation       role = OWNER, SHA-256(token) stored, expires in 168h
       outbox_event     ORGANIZATION_PROVISIONED, payload carries the RAW token
     Refuses first: an owner who is a platform admin (rule 9), a taken slug,
     a taken domain (§2.3 — two salespeople, one lead).
     201 returns acceptUrl, shown once.

→ 3  The worker's outbox poller claims the row; dispatchTenantEvent:
       notification  ORGANIZATION_CREATED, template organization-created,
                     dedupe key = event id, locale from tenant.defaultLanguage,
                     payload carries acceptUrl — the sender cannot rebuild it
       enqueue → notifications queue → sendNotification → EmailProvider
     markProcessed then clears the outbox payload, so the raw token's lifetime
     is measured in seconds.

→ 4  The owner clicks the link and sets a password (§2.5 A2, built 2026-07-30 —
     see phase-9-owner-onboarding.md).
     POST /v1/invitations/lookup   names the organization before asking for a
                                   password, and says whether an account exists
     POST /v1/invitations/accept-and-register
                                   the address comes from the invitation, never
                                   from the body; user created emailVerified;
                                   membership + invitation in one transaction;
                                   returns a session.
     Someone who already has an account is sent to sign in and the ordinary
     POST /v1/invitations/accept, which is unchanged.

→ 5  Signed in, GET /v1/me returns tenant.status = PENDING_SUBSCRIPTION,
     membership.role = OWNER, and the permission list.
     Every write is refused by requireWritableTenant, because tenantAcceptsWrites
     is an allow-list of ACTIVE | TRIAL. Reads are allowed: tenantIsReadable
     excludes only CLOSED, so the owner can see the organization they are paying
     for.

→ 6  The dashboard explains the refusal instead of 403-ing a clicked link (§2.11).
     Gated items render as aria-disabled spans, not dimmed links — an anchor
     stays focusable and activates however it is painted. Overview and
     Subscription stay live; a three-step panel says what happens next.

→ 7  The owner subscribes: POST /v1/billing/subscribe emails a Stripe Payment
     Link and returns it, so neither a slow inbox nor a closed tab blocks them.
     Paying fires checkout.session.completed → the webhook records it → the
     worker's stripe poller sets ACTIVE and clears subscribe_by.
     ⊘ A platform admin activating manually (§5.1 D3) is still unbuilt.

⊘ 8  The sweep closes prospects past subscribe_by, having warned them (§2.6, §6).
```

The gate in step 5 is the load-bearing part, and it is load-bearing in a way that is easy to lose: it is
correct today _because_ `tenantAcceptsWrites` was written as an allow-list. `PENDING_SUBSCRIPTION` was gated
the moment the enum value was added, with no separate change. Inverted into `!== SUSPENDED`, every future
status would arrive un-gated.

## 1.5 Verifying the email without a provider

Step 3 has never been run against Resend. It does not need to be, to be tested: leave `RESEND_API_KEY`
unset and `createLoggingProvider` writes the entire rendered message — subject, text body, accept URL — to
the worker log. Provision a prospect, watch the worker, click the URL out of the log.

Two things this does not cover, and they are the ones that break in production: whether `EMAIL_FROM` is a
verified sender at the provider, and how the HTML renders in a real client. The config schema already refuses
a half-configured pair — `RESEND_API_KEY` and `EMAIL_FROM` must be set together or both unset — so the
failure mode is a startup error rather than a silently unsent email.

The logging provider logs the recipient address, which is a deliberate exception to rule 6 and safe only
because the provider is never selected when a key is present.

---

# 2. Decisions

## 2.1 The idle state is a tenant status, not a subscription lookup

An organization awaiting its first subscription needs a state, and the temptation is to infer it — "no
subscription row means idle". Resist it: that makes every authorization decision a join, and it cannot
distinguish _never subscribed_ from _subscribed and lapsed_, which are different situations with different
correct outcomes (§2.6).

Add one value to `TenantStatus`, which already has `TRIAL`, `ACTIVE`, `SUSPENDED`, `CLOSED`:

```text
PENDING_SUBSCRIPTION   provisioned, owner can sign in, nothing configurable yet
```

Named for _why_ it is idle rather than that it is idle.

`TRIAL` is **retained deliberately and left unused by this flow** (product owner, 2026-07-29). It means what
it has always meant — the product working, free, for a period — which `PENDING_SUBSCRIPTION` is not, since
nothing works. Keeping the two distinct now costs one unused enum value and saves having to disentangle them
when a real free-trial offering arrives. `tenantAcceptsWrites` already returns true for `TRIAL`, so that
offering will work the day it is sold.

The lifecycle:

```text
                    subscribe
PENDING_SUBSCRIPTION ────────▶ ACTIVE ──payment lapses──▶ SUSPENDED
         │                        │                           │
         │ window expires         └──────── reactivate ───────┘
         ▼
      CLOSED

TRIAL ──────────────────────▶ ACTIVE          reserved; no flow reaches it yet
```

## 2.2 Two kinds of provisioning, because not every organization has a prospect

The platform admin also provisions organizations with no prospect behind them — demos, internal use,
testing (product owner, 2026-07-29). Those must not be gated and must not expire, so provisioning takes a
mode:

| Mode         | Status                 | `subscribe_by` | Expires? | Configurable? |
| ------------ | ---------------------- | -------------- | -------- | ------------- |
| **Prospect** | `PENDING_SUBSCRIPTION` | set            | yes      | no            |
| **Internal** | `ACTIVE`               | `NULL`         | no       | yes           |

An internal organization created as `PENDING_SUBSCRIPTION` would be useless — the write gate would stop it
being configured, which is the whole point of a demo — so it is created `ACTIVE` outright.

That leaves an `ACTIVE` tenant with nobody paying, which quota enforcement (tech-impl §37) would trip over
when it looks for a plan. So an internal organization gets a `Subscription` row with `plan = INTERNAL` and
no Stripe identifiers. This buys an invariant worth having: **every `ACTIVE` tenant has a subscription row**,
and "which plan is this tenant on" never returns nothing.

## 2.3 The organization is identified by its domain

A prospect is a business with a domain — `wellness.hu` — and that is what identifies their organization
(product owner, 2026-07-29). `Tenant` gains a unique `domain`, captured at provisioning and required.

This does **not** replace `slug`. The two answer different questions and both are needed:

| Field    | Is                         | Used for                                      | Chosen by    |
| -------- | -------------------------- | --------------------------------------------- | ------------ |
| `slug`   | a URL segment              | `booking.example.com/wellness` — public links | admin/owner  |
| `domain` | the business's real domain | identity, custom-domain routing, dedupe       | the prospect |

Making `domain` the identifier buys the thing that matters for a sales-led product: **the platform admin
cannot provision the same business twice.** Two salespeople working the same lead produce one organization
and a unique-constraint violation rather than two half-configured tenants nobody notices until billing.

`booking-for-all` reached the same conclusion — `Organization.domain` is `String? @unique` there — but left
it nullable, so the guarantee only holds for rows that happened to fill it in.

**As built, ours is `String? @unique @db.Citext` too** — required by `provisionOrganizationBodySchema` at the
API edge, nullable in the database, because tenants that predate this column (the seed, anything created
through self-serve) have no domain to give. So the plan's "here it is required" is true of provisioning and
not of the column. That is the right trade for now and worth being explicit about rather than discovering
later: the uniqueness guarantee §2.3 exists for holds for every provisioned organization, and the null rows
are legacy that step 3 of §8 stops producing. `Citext` means the constraint is case-insensitive in the
database as well as after `normalizeDomain`, which is belt and braces on purpose — normalisation is a pure
function that could be forgotten at a new call site.

Normalisation matters, or the constraint is decorative: lower-cased, trimmed, `www.` stripped, no scheme,
no path. `WWW.Wellness.HU/` and `wellness.hu` are the same business. That belongs in a pure function with
its own tests, next to the slug validation already in `tenant.schemas.ts`.

## 2.4 The write gate must not block the act that lifts it

`tenantAcceptsWrites` already exists in `@bam/auth/policy` and already gates writes on status, checked
before permissions. So the activation gate is one line: `PENDING_SUBSCRIPTION` accepts no writes.

**The trap this creates is the single most important implementation detail in this document.** Subscribing
is itself a write. Gate it with everything else and the owner can never subscribe, can never leave
`PENDING_SUBSCRIPTION`, and their organization expires while they are trying to pay for it. The bug would
be discovered by the first real customer.

Billing routes are therefore exempt from `tenantAcceptsWrites` by construction, not by remembering.

**How the exemption is expressed — decided 2026-07-30.** Three shapes were considered:

|     | Shape                                                  | Fails how                                                                                                |
| --- | ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| C1  | Opt-in `preHandler`; billing simply never registers it | forgetting to **add** the guard un-gates a module silently — the dangerous direction                     |
| C2  | Global gate plus a central exemption list              | forgetting to add billing to the list breaks checkout loudly, but the exemption lives far from the route |
| C3  | Global gate plus a per-route `config` flag it reads    | fails loudly like C2, and the exemption is visible and greppable at the route                            |

**C3.** What exists today is C1: `requireWritableTenant` is an opt-in `preHandler` in
`authorization.plugin.ts` that each write route registers for itself. That is fine while every write should
be gated and nothing needs an exemption — the moment billing needs one, C1 makes "is this route gated?" a
question you answer by reading the route list rather than the route. C3 keeps the answer local:

```text
config: { acceptsWritesExempt: true }     // read by one onRequest/preHandler hook
```

Migrating is mechanical — the guard body already exists and does not change; what changes is who calls it.
Either way the test in this section is the one that matters: an owner in `PENDING_SUBSCRIPTION` can reach
checkout and cannot reach service creation.

What the owner may do while pending: sign in, see the dashboard, read tenant settings, subscribe. Nothing
else — not even inviting colleagues. Strictness is what makes discarding safe (§2.6): an organization that
cannot accumulate anything can be discarded without losing anything.

## 2.5 No password is ever emailed

The original flow described "a temporary password". Recommend against, and the alternative is already built.

An emailed password has no expiry, persists in the mailbox indefinitely, survives a later mailbox
compromise, is frequently reused by the recipient elsewhere, and proves nothing about who used it. It also
requires the platform to know a password it has no business knowing.

The repository already solves this twice — invitations and booking-management tokens, both per tech-impl
§34.4: a single-use token whose SHA-256 hash alone is stored, shown once, with an expiry
(`INVITATION_EXPIRY_HOURS`, default 168). Provisioning is therefore:

```text
create tenant (PENDING_SUBSCRIPTION)  →  issue an OWNER Invitation  →  email the accept link
```

The owner sets their own password; the platform never holds one.

**The wrinkle, and its resolution — decided 2026-07-30.** `POST /v1/members/accept` requires the caller to be
signed in (`preHandler: [app.requireAuth]`) and matches the invited email against the session's. A brand-new
owner has no account, so the built path is worse than the "two steps" this document originally called it.
Measured against the code: click the link → `accept-invitation.tsx` finds no session and renders
`needs-sign-in` → pushed to `/sign-in` → realise you have no account → find `/sign-up` → register with the
invited address → navigate back to the link → accept. Four steps, one of them undiscoverable, at the exact
moment the product makes its first impression.

The alternatives:

|     | Flow                                                                                                   | Cost                                                                                                 |
| --- | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| A1  | Status quo: sign up manually, then re-click the link                                                   | no code; silently loses people                                                                       |
| A2  | **Accept-and-register**: link → set-password form → account, membership and session in one transaction | one new unauthenticated route                                                                        |
| A3  | Magic-link sign-in, password set later or never                                                        | the accept link becomes a session grant — a far stronger credential to leave in a mailbox for a week |
| A4  | `/sign-up?invitation=<token>`, email prefilled and locked, accept on success                           | web-side only; keeps the two-step for people who already have accounts                               |

**A2, with A4's prefill as the path for an invitee who already has an account.** A2 is the only option that
makes first-run a single form, and it needs no new trust assumption: the invitation token is already proof of
control of that mailbox, which is exactly what registration would otherwise send a verification email to
establish. So the new route consumes the token, creates the Better Auth user with the invited address
**already verified**, creates the membership, and returns a session — one transaction, because a user created
without a membership is the half-state that made the original flow confusing.

A3 is refused for a stated reason rather than taste: a 168-hour link that signs the bearer in is a
password-equivalent with none of a password's revocability, and §2.5's whole argument is against leaving
those in mailboxes.

This is what the email copy encodes, so it was blocking §6's templates. It no longer is: the copy says
_"choose a password and your organization is ready"_, one action, one link.

**The invitation expiry stays at 168 hours, deliberately shorter than the onboarding window** (product
owner, 2026-07-29). Seven days to click a link, fourteen for the organization to be paid for.

The consequence has to be built, not tolerated: an owner who lets the link lapse still has eight days of
organization left and no way in. So **resending an invitation is a first-class action on the platform-admin
dashboard**, not a database fix. It reissues a fresh token, revokes the old one, and re-sends
`ORGANIZATION_CREATED`. Without it, the most likely support request in the whole flow has no answer.

Keeping the shorter expiry is the right call regardless: a provisioning link is a credential, and a
credential valid for two weeks is a worse thing to leave in a mailbox than one valid for one.

## 2.6 Discarding is closing, not deleting — and only for those who never subscribed

"Discard" needs two decisions.

**What it means.** `CLOSED`, not `DELETE`. The tenant row is the record of who was pitched and did not
convert, which is worth keeping; `tenantIsReadable` already returns false for `CLOSED`, so a closed
organization disappears from use without disappearing from history. Hard deletion, if wanted, belongs to the
retention policy in tech-impl §35 on a much longer clock — not to onboarding. This mirrors rule 11's
instinct: `active` and `archivedAt` are different questions, and so are "closed" and "gone".

**Who it applies to.** Only organizations that _never_ subscribed. A tenant that subscribed and later lapsed
is a former customer whose data carries obligations — invoices, bookings taken, personal data of their
customers — and it goes to `SUSPENDED`, never to automatic closure. This is exactly the distinction §2.1
said a subscription-lookup could not make, and it is why the state is stored.

**How it runs.** A sweep on the worker's `retention-cleanup` queue, already declared in
`apps/worker/src/queues.ts` for precisely this class of job. The window is config, not a constant:
`ONBOARDING_WINDOW_DAYS`, default 14.

The predicate must be written so an internal organization can never match it (§2.2):

```sql
WHERE status = 'PENDING_SUBSCRIPTION'
  AND subscribe_by IS NOT NULL      -- internal organizations have no deadline
  AND subscribe_by < now()
```

`subscribe_by IS NOT NULL` is doing real work and should not be "simplified" away. An internal organization
is `ACTIVE` so the first condition already excludes it, but a sweep that deletes organizations deserves two
independent reasons to skip the ones nobody is paying for on purpose.

The owner should be warned before it happens — see §6. An organization vanishing without notice is the kind
of thing customers remember.

### 2.6.1 A closed prospect is reopened, not provisioned again — decided 2026-07-30

Closing is not the end of the sales relationship, and the built code makes that awkward in a way the plan
did not foresee. `slug` and `domain` are unique across _all_ tenants, `CLOSED` included, so a prospect who
lapsed six months ago and has now come back cannot be provisioned: `assertAvailable` rejects the domain and
says an organization already exists — true, and useless, because that organization is invisible to everyone
including the salesperson reading the error.

Three ways out were considered:

|     | Approach                                                                      | Cost                                                                                                   |
| --- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
|     | Free `slug` and `domain` on closure                                           | nulling `domain` destroys the record of who was pitched — the stated reason for keeping the row at all |
|     | Partial constraints: unique `WHERE status != 'CLOSED'`                        | a migration, and it makes "is this domain taken" a question with two answers depending on who asks     |
|     | **Reopen** — a platform-admin action moving `CLOSED` → `PENDING_SUBSCRIPTION` | needs the closed organization to be findable, which the dashboard's status filter already allows       |

**Reopen.** It is the only one that matches what is actually happening: the salesperson is returning to a
known lead, not discovering a new one. It needs no constraint change, it keeps the history §2.6 exists to
keep, and it keeps one answer to "does an organization exist for this domain".

What it does:

```text
CLOSED  →  PENDING_SUBSCRIPTION
           subscribe_by = now + ONBOARDING_WINDOW_DAYS   (a fresh window, not the old one)
           a new OWNER invitation, superseding any stale row
           an ORGANIZATION_PROVISIONED outbox event — the same email as the first time
```

Three constraints on it, each for a reason:

- **Only from `CLOSED`, and only where a subscription never existed.** Reopening a former _customer_ is a
  different act with different obligations, and it already has its own path: `SUSPENDED` → `ACTIVE` via
  reactivation. Conflating them would let an invoiced customer be quietly returned to a pre-payment state.
- **The owner may be a different person.** A business that comes back a year later may have replaced whoever
  was pitched, so reopening takes an `ownerEmail` rather than reusing the old invitation's. It runs the same
  `canHoldTenantMembership` refusal as provisioning — rule 9 does not lapse because a tenant is being reused.
- **It is audited as its own action**, `platform.organization_reopened`, not as a status change. An operator
  reading the trail should see that a closed organization was deliberately returned to the funnel, which is
  not the same event as a suspension being lifted.

This makes `setStatus` unsuitable as the mechanism: it exists to toggle `ACTIVE`/`SUSPENDED` and explicitly
refuses `CLOSED` rows. Reopening is a separate route (§4) that does more than set a column.

## 2.7 What to take from `booking-for-all`'s subscription code, and what not to

The predecessor's `features/subscriptions/routes.ts` and `features/webhooks/stripe.ts` implement this whole
flow already. Read before designing ours; the shape is right and several details are worth taking verbatim.

**Take:**

- **Checkout metadata carries the organization id, on both the session and the subscription.**
  `subscription_data.metadata` is the important half: webhooks for renewals and cancellations arrive with a
  subscription object and no session, so without it there is nothing to join on.
- **The price id is validated against an allow-list** before creating a session. Without it a caller can
  name any price in the Stripe account, including a cheaper one from a different product.
- **A `sync-from-stripe` reconciliation route.** Webhooks get missed — a deploy at the wrong moment, an
  endpoint misconfigured — and the recovery is to ask Stripe what actually happened rather than to fix rows
  by hand. This is the piece most projects omit and then need at the worst moment.
- **`ensurePortalConfig()`** — creating the billing-portal configuration on demand rather than requiring a
  dashboard click during setup.
- **Refusing checkout when the organization is already subscribed**, which stops double billing from a
  double-clicked button.

**Do not take:**

- **The webhook handler acts inline and returns 400 on failure.** Stripe retries anything slow or failed,
  and with no event-id table each retry re-runs the handler. Ours records the event, enqueues, and returns
  200 (§2.9).
- **`Subscription.userId`.** Tying a subscription to the user who happened to pay means it breaks when that
  person leaves. The organization pays, not a person; ours keys on `tenantId` alone.
- **`enabled` alongside `status`.** Two booleans-worth of truth for one question, free to disagree.
- **`status String`** as free text on the subscription. An unrecognised value from Stripe should be a loud
  failure, not a row nobody notices; ours is an enum.
- **`process.env` read at each call site**, with three-deep `||` fallbacks for the frontend URL. That is
  rule 3, and the fallbacks mean a misconfigured deploy silently sends customers to localhost.

## 2.8 Stripe owns billing; we mirror only what we act on

Stripe is the source of truth for money. Mirroring its full state is a synchronisation problem with no
upside — the customer portal already answers "what am I paying". Locally we need only what the application
_acts_ on: whether writes are allowed, the plan (for quotas, tech-impl §37), and identifiers to deep-link
into Stripe from the admin dashboard.

## 2.9 Webhooks redeliver, so every handler is idempotent

Stripe delivers at-least-once and retries for days. Activating twice is harmless; creating a second
subscription row is not, and neither is sending the platform admin two notifications per sale.

Epic 5 built the pattern: a unique key, the database refusing the duplicate, application code translating
the constraint violation rather than checking first (rules 14 and 16). Applied here as a `stripe_events`
table keyed on Stripe's event id, plus a unique constraint on `Subscription.tenantId`.

The handler records the event and enqueues; it does not act inline. Stripe retries any response slower than
a few seconds, so slow work inside the handler causes the very duplicate delivery it is trying to process.
The `outbox_events` table and its dispatcher already exist.

The webhook route also needs the **raw body** for signature verification, which Fastify parses away by
default. Called out here rather than discovered later.

## 2.10 Self-serve creation is removed, not merely guarded

Once provisioning exists, `POST /v1/tenants` has no legitimate caller, and a restricted-but-present route
invites its own return. Delete it; keep `TenantService.create` as the mechanism provisioning calls, taking
the owner's user id as a parameter rather than the caller's.

Not done yet (§1.2), and note the second half of the job: the web dashboard still offers the form that calls
it (`dashboard.tsx`, the create-tenant mutation). Removing the route without removing the form leaves a
button that 404s.

## 2.11 The pending dashboard says what it refuses, and why — decided and built 2026-07-30

The API already refuses writes from a `PENDING_SUBSCRIPTION` tenant, and `GET /v1/me` already returns
`tenant.status`, so the client has everything it needs to explain itself. It does not use it:
`dashboard-shell.tsx` renders all six navigation items unconditionally, so today an owner clicks
"Services" and receives a 403 with no account of what would fix it. §7 called that an interface failure
before it existed; it now exists.

|     | Behaviour                                                                               | Cost                                                      |
| --- | --------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| B1  | Hide the gated items until `ACTIVE`                                                     | cleanest; the owner cannot see what they are about to buy |
| B2  | **Disable with a reason** — greyed, `aria-disabled`, an explanation                     | needs `hu`/`en` copy                                      |
| B3  | Reachable but read-only: empty states with a subscribe CTA where the create button goes | most work, best sales pitch                               |
| B4  | Any gated route redirects to billing                                                    | one guard; traps someone who only wanted to look          |

**B2, plus a first-class pending panel on `/dashboard`** — what the organization will be able to do, the
subscribe action, and how long remains. Disabled rather than hidden because this screen is doing sales work:
an owner who cannot see the shape of the product has less reason to pay for it. `aria-disabled` with an
accessible explanation rather than a bare `disabled` attribute, so the reason reaches a screen reader and
not only a tooltip — the definition of done requires the accessibility review either way.

B3 is the version to build if the pending screen turns out to be where deals are lost. It is strictly more
work than B2 and strictly compatible with it, so B2 first is not a decision that has to be revisited, only
extended.

The panel's "days remaining" comes from `daysRemaining` in the platform summary, which floors at zero, so an
overdue organization reads as 0 days rather than a negative number. The owner-facing equivalent needs the
same treatment — the value is derived from `subscribe_by`, which is null for internal organizations, and the
panel must not render at all in that case.

---

# 3. Data model

Following existing conventions — cuid(2) ids, snake_case `@@map`, `timestamptz`:

```text
Tenant   (existing, gains one column; TenantStatus gains one value)
+ status              PENDING_SUBSCRIPTION added; TRIAL retained, unused (§2.1)
+ subscribe_by        timestamptz NULLABLE
                      set at prospect provisioning · cleared on subscribe
                      always NULL for internal organizations (§2.2)

subscriptions
- id, tenant_id UNIQUE
- stripe_customer_id        nullable   ← NULL for plan = INTERNAL
- stripe_subscription_id    nullable UNIQUE
- plan, status, current_period_end nullable, cancel_at_period_end
- created_at, updated_at

stripe_events                      ← webhook idempotency
- id (Stripe's event id, PK)
- type, payload_json, received_at, processed_at nullable
```

No `Offer` model, no `Lead` model. The tenant is the record from the moment it is provisioned.

The Stripe columns are **nullable so that internal organizations can hold a subscription row without a
Stripe counterpart** (§2.2). PostgreSQL permits repeated NULLs under a unique index, so
`stripe_subscription_id UNIQUE` still refuses two tenants claiming one real Stripe subscription while
allowing any number of internal rows.

**Resolved at build time: `plan` is an enum.** The question was enum against string — an enum makes adding a
plan a migration, a string makes a typo a silent mispricing. `OutboxEvent.eventType` favours strings for
things that change often, but plans change rarely and mispricing is expensive. Built as
`SubscriptionPlan { INTERNAL, STARTER, PROFESSIONAL }`, which also gives `INTERNAL` the natural home §2.2
needed. `SubscriptionStatus` went the same way and for the same reason (§2.7): an unrecognised value from a
webhook should be a loud failure.

---

# 4. API surface

Platform routes sit behind a new `requirePlatformAdmin` guard. It must check the **flag**, not a permission:
`can()` already returns true for a platform admin everywhere, so a permission check would pass for ordinary
owners of nothing in particular.

`✓` is built, as of 2026-07-30.

```text
✓ POST   /v1/platform/organizations        provision; body carries mode: PROSPECT | INTERNAL (§2.2)
✓ GET    /v1/platform/organizations        list, with status, subscription state and days remaining
✓ POST   /v1/platform/organizations/:id/resend-invitation   reissue a lapsed link (§2.5)
✓ PATCH  /v1/platform/organizations/:id/status              suspend / reactivate
                                           built as one PATCH rather than the planned /suspend and
                                           /reactivate verbs; closing is deliberately not settable here.
  POST   /v1/platform/organizations/:id/reopen              CLOSED → PENDING_SUBSCRIPTION (§2.6.1)
                                           body carries ownerEmail — the contact may have changed.
  POST   /v1/platform/organizations/:id/activate            manual activation (§5.1 D3)
                                           body carries the plan; writes the subscription row §2.2 requires.
  GET    /v1/platform/subscriptions        overview for the dashboard

✓ POST   /v1/invitations/lookup           describe an invitation to an anonymous holder of its token
                                           token in the body, not the path — it is a bearer credential.
✓ POST   /v1/invitations/accept-and-register   token + password → user, membership, session (§2.5)
                                           unauthenticated by necessity: the caller has no account yet.

✓ POST   /v1/billing/subscribe            email the owner a payment link, and return it
                                           ← exempt from the write gate (§2.4). Replaces the planned
                                             GET /billing/checkout: a Payment Link needs no session
                                             created, so this is a request to send, not to check out.
✓ GET    /v1/billing/subscription         what the owner has, and which plans they may buy
✓ POST   /v1/billing/portal               Stripe customer-portal link   ← exempt from the write gate
                                           POST rather than the GET planned here: creating a session is
                                           a side effect and the URL expires in minutes, so a prefetch
                                           would burn one (phase-9-customer-portal.md §1.2). Exempt for
                                           a second reason too — a SUSPENDED ex-customer accepts no
                                           writes, and this is the screen that fixes that.

✓ POST   /v1/webhooks/stripe               unauthenticated, signature-verified, raw body
                                           registered only when Stripe is configured — with no key
                                           nothing could verify a signature (rule 4).
```

Every route schema-first per rule 2. `/v1/platform/*` sits outside the tenant-scoped tree because these
calls carry no `X-Tenant-Id`; `platform` is already in the reserved-slug list in `tenant.schemas.ts`, so no
tenant can shadow it.

`accept-and-register` sits beside the existing `POST /v1/members/accept` rather than replacing it: that route
stays, for an invitee who already has an account. The new one is for the person who does not, which in this
flow is every owner.

---

# 5. Stripe integration

Per rule 4 the client is lazily constructed in a `getStripe()`; a missing key degrades billing and nothing
else. New config, paired the way the Resend keys already are:

```text
STRIPE_SECRET_KEY                  optional
STRIPE_WEBHOOK_SECRET              required if STRIPE_SECRET_KEY is set
STRIPE_PAYMENT_LINK_STARTER        a permanent Payment Link, not a price id — see §5.1
STRIPE_PAYMENT_LINK_PROFESSIONAL   likewise
ONBOARDING_WINDOW_DAYS             default 14   ← already exists
```

**Built as of 2026-07-30**, with `STRIPE_PAYMENT_LINK_*` in place of the `STRIPE_PRICE_*` this section
originally planned. The reason is in §5.1's amendment below.

**The plans are named, which is all that had to be settled now** (2026-07-30). `SubscriptionPlan` is already
`INTERNAL | STARTER | PROFESSIONAL` in the schema — an enum rather than a string, resolving §3's open
modelling question in favour of a migration per plan over a typo per mispricing. `INTERNAL` is not sold
(§2.2); the two that are sold take the names PRD §"Example plan limits" sketched.

What each plan _limits_ stays open (§10.1) and does not block anything until quota enforcement. Naming them
is what unblocks manual activation, which has to write a plan onto the subscription row.

PRD's sketch also lists **Enterprise**, and the enum deliberately omits it. An enterprise arrangement is
"custom usage and limits" — a negotiated deal, not a price id — so it is better served by an `INTERNAL`-style
row with per-tenant overrides than by a third self-serve plan that Checkout would then need a price for.
Adding the value later is one migration, and there is nothing to migrate until a deal exists.

Events consumed:

| Event                           | Effect                                                       | State       |
| ------------------------------- | ------------------------------------------------------------ | ----------- |
| `checkout.session.completed`    | tenant → ACTIVE, clear `subscribe_by`, upsert `Subscription` | **built**   |
| `customer.subscription.updated` | mirror plan, status, period end, `cancel_at_period_end`      | **built**   |
| `customer.subscription.deleted` | tenant → SUSPENDED (never CLOSED — see §2.6)                 | **built**   |
| `invoice.payment_failed`        | notify the owner; grace period before suspension             | outstanding |

Notifying the platform admin on a completed checkout is **not** built — `SUBSCRIPTION_CREATED` in §6 remains
outstanding along with `PAYMENT_FAILED`.

Outbound calls carry an idempotency key, as Stripe expects and as rule 16 already requires of our own
retryable writes.

The owner's self-service billing is Stripe's **customer portal** — a generated link, not screens we build.

## 5.1 How the owner pays — decided 2026-07-30

|     | Approach                                                             | Cost                                                               |
| --- | -------------------------------------------------------------------- | ------------------------------------------------------------------ |
| D1  | **Stripe Checkout + customer portal**                                | no card handling, no billing UI; redirects off-site mid-onboarding |
| D2  | Embedded Payment Element                                             | stays in-app; you own SCA, dunning and invoice display             |
| D3  | **Admin marks as paid** — invoiced by hand, platform admin activates | no Stripe work at all; does not scale past a handful of customers  |
| D4  | Payment link, no webhook; admin activates on notification            | webhook-free, but activation lags the payment                      |

**D1 as the product, D3 as a deliberate interim and a permanent escape hatch.**

> ### Amended 2026-07-30, at build time — D1 uses a Payment Link, not a Checkout Session
>
> The checkout half of D1 changed when the product owner chose to **email** the link rather than redirect to
> it, so that an owner can forward it to whoever holds the company card
> ([phase-9-subscription-and-activation.md](phase-9-subscription-and-activation.md) §1.1).
>
> That makes a Checkout Session the wrong artifact: **Stripe expires one within 24 hours**, and
> `ONBOARDING_WINDOW_DAYS` is 14. An emailed checkout URL would therefore be dead for thirteen of the
> fourteen days it exists to cover — and dead at the worst moment, when the recipient finally sits down to
> pay. A **Payment Link** is permanent, needs no API call to produce, and carries the tenant in
> `client_reference_id`.
>
> What it costs, stated plainly: plans are configured in the Stripe dashboard rather than in our code, so
> adding one means creating a link there and adding an environment variable. Acceptable for two plans.
>
> Also worth recording, because the original reasoning was wrong: emailing the link does **not** reduce card
> handling. Stripe's hosted page takes the card whether the owner clicks a button that redirects or a link in
> an inbox, and nothing sensitive touches this API in either design. The real benefit is forwardability, and
> that is the one to defend if the decision is ever revisited.
>
> D2 stays refused. D3 stays wanted — it is the permanent bank-transfer path and is still unbuilt. The
> customer portal remains the answer for self-service billing once a subscription exists, and was built on
> 2026-07-31 — see [phase-9-customer-portal.md](phase-9-customer-portal.md), which also records the two
> mirroring faults the portal exposed in the webhook processor.

The interim is worth the paragraph. Everything in this flow except step 3 — provisioning, the email,
acceptance, the pending dashboard, the expiry sweep, the warnings — can be exercised end to end with no
Stripe account in existence, provided something can move a tenant from `PENDING_SUBSCRIPTION` to `ACTIVE`.
That something is one platform-admin action, and it is not throwaway scaffolding: a customer who insists on
a bank transfer needs exactly the same button forever. So it is built as a real audited route rather than a
test fixture, and it stays after D1 lands.

It carries one obligation. Activating without a Stripe subscription breaks §2.2's invariant that every
`ACTIVE` tenant has a subscription row, so a manual activation must write one — plan as sold, no Stripe
identifiers, in the same shape `INTERNAL` already uses. Without that, quota enforcement meets its first
missing plan in production rather than in a test.

D2 is refused: it buys a marginally smoother flow in exchange for owning card compliance, dunning and invoice
rendering, for a product whose customers are businesses being sold to by a human.

---

# 6. Notifications required

All Epic 5 machinery. Each needs a `NotificationType` value, a template, and `hu`/`en` copy:

| Type                    | To             | When                                            | State           |
| ----------------------- | -------------- | ----------------------------------------------- | --------------- |
| `ORGANIZATION_CREATED`  | owner          | provisioning, and again on resend — accept link | **built**       |
| `INVITATION_EXPIRING`   | owner          | ~24h before the 168h link lapses                | needs part 3    |
| `SUBSCRIPTION_EXPIRING` | owner          | 7, 3 and 1 days before `subscribe_by`           | needs part 3    |
| `SUBSCRIPTION_CREATED`  | platform admin | checkout completes                              | needs Stripe    |
| `ORGANIZATION_CLOSED`   | owner          | the window lapsed                               | needs the sweep |
| `PAYMENT_FAILED`        | owner          | Stripe reports a failed invoice                 | needs Stripe    |

`ORGANIZATION_CREATED` is the first template in the repository — it is currently the only entry in
`RENDERABLE_TYPES`, ahead of the booking templates part 2 was scoped around, because this flow needed it
first. Its copy is now settled by §2.5's A2 decision, which it was waiting on.

The four rows that "need part 3" or "need Stripe" are all deliverable the moment their dependency lands;
none of them needs a mechanism that does not exist in design.

Internal organizations (§2.2) receive none of the expiry notifications: `subscribe_by` is NULL, so there is
no instant to schedule them at. That falls out of the model rather than needing a special case, which is a
sign the model is right.

`INVITATION_EXPIRING` exists because the link now dies a week before the organization does (§2.5). Warning
the owner is cheaper than the support request, and it fires only if the invitation is still PENDING.

`SUBSCRIPTION_CREATED` is staff-facing with no customer recipient, which the notification engine already
anticipates: `CALENDAR_DISCONNECTED` is the same shape and `Notification.bookingId`/`customerId` are already
nullable for it.

`SUBSCRIPTION_EXPIRING` and `INVITATION_EXPIRING` are scheduled notifications at known future instants —
exactly what the reminder machinery in Epic 5 part 3 does, including the queue-horizon rule that keeps
distant jobs out of Redis. Both must be cancelled when the thing they warn about no longer applies, which
the dedupe key handles the same way a rescheduled booking's reminder is handled.

---

# 7. Web

- `/platform` — admin dashboard: organizations, subscriptions, provisioning. Behind the platform-admin flag.
- `/dashboard/billing` — plan, usage against quota, a button to the Stripe portal.
- **The pending state is a first-class screen, not an error.** An owner in `PENDING_SUBSCRIPTION` who clicks
  "add a service" and gets a 403 has been failed by the interface. The dashboard should show what the
  organization will be able to do, a clear subscribe action, and how long remains.

The owner's first-run experience matters more than it sounds: they arrive at an empty organization they
cannot yet configure. That screen is the product's first impression.

---

# 8. Sequencing

Struck-through steps are done (§1.2). The order below is the original plan's, corrected where reality took a
different route.

1. ~~Epic 5 part 1, and enough of part 2 to deliver mail.~~ Part 3 is still outstanding and now blocks only
   step 8.
2. ~~`PENDING_SUBSCRIPTION`, `subscribe_by`, `Subscription`, `stripe_events`, migrations.~~
3. ~~`requirePlatformAdmin`; provisioning route~~; **remove self-serve creation, and the form that calls it**
   (§2.10).
4. ~~The write gate~~; its billing exemption via `acceptsWritesExempt`, with the test in §2.4.
5. ~~Platform-admin dashboard.~~ Built earlier than planned, because provisioning is unusable without it.

Remaining, in the order that keeps the flow testable at every step:

6. ~~**Accept-and-register** (§2.5 A2).~~ Done 2026-07-30 — recorded in
   [phase-9-owner-onboarding.md](phase-9-owner-onboarding.md), together with the invitation landing page and
   `pnpm db:discard-organization`, which makes the test loop repeatable. It went first because until it
   existed the flow could not be walked by anyone who was not already a user.
7. **The pending owner dashboard** (§2.11 B2) and **subscription by emailed Payment Link** — planned
   together in [phase-9-subscription-and-activation.md](phase-9-subscription-and-activation.md), because the
   dashboard's only live action is the subscribe button and building one without the other leaves a screen
   that explains a step it cannot take. That document **amends §5.1's D1**: a Payment Link rather than a
   Checkout Session, since a session expires in 24 hours and the window is 14 days.
8. **Manual activation** (§5.1 D3), writing the subscription row §2.2 requires. Still wanted after the
   webhook lands — it is the permanent path for a customer who pays by transfer.
9. **The expiry sweep** on `retention-cleanup`, plus `ORGANIZATION_CLOSED`, plus **reopen** (§2.6.1). Needs
   Epic 5 part 3 for the scheduled warnings; the sweep itself does not. Reopen ships with the sweep rather
   than after it — the sweep is what creates closed organizations, and shipping the thing that closes them
   without the thing that recovers them is how a support request becomes a database edit.
10. **Stripe**: client, checkout, portal, webhook route, `stripe_events` idempotency, `sync-from-stripe`.
11. **Usage quotas and suspension** — what the epic was originally scoped as.

Steps 1–10 are the onboarding flow; step 11 is the original Epic 9. They share the subscription model, which
is why they are one epic.

The reordering has one point: **steps 6–9 deliver a complete, walkable onboarding flow with no Stripe account
in existence.** Stripe then replaces one manual action rather than being the thing everything else waits for.

---

# 9. Settled

Answered by the product owner, 2026-07-29:

- **`TRIAL` survives**, reserved for a real free-trial offering later rather than repurposed here (§2.1).
- **The platform admin provisions without a prospect**, so provisioning has two modes and internal
  organizations neither expire nor are gated (§2.2).
- **Invitation expiry stays 168 hours**, shorter than the onboarding window, which makes resending an
  invitation a first-class dashboard action (§2.4).

Decided 2026-07-30, reviewing the built flow against the alternatives:

- **Accept-and-register** (§2.5, A2). One unauthenticated route takes the token and a password and returns a
  session. The token is the proof of mailbox control, so the invited address is created already verified.
  Magic-link acceptance (A3) was refused: it turns the link into a password-equivalent with no revocability.
- **The pending dashboard disables with a reason** (§2.11, B2), rather than hiding the navigation, and gains a
  first-class panel showing what the organization will do and how long remains.
- **The write-gate exemption is a per-route `config` flag** read by one hook (§2.4, C3), replacing today's
  opt-in `preHandler`, so a route's gated-ness is legible at the route.
- **Stripe Checkout plus the customer portal** is the product; **manual activation by a platform admin** is
  both the interim that unblocks testing and the permanent path for a customer who pays by transfer (§5.1,
  D1 + D3). A manual activation must write a subscription row, or §2.2's invariant breaks.
- **A closed prospect is reopened, not provisioned again** (§2.6.1). One platform-admin route moves
  `CLOSED` → `PENDING_SUBSCRIPTION` with a fresh window and a new invitation, taking an `ownerEmail` because
  the contact may have changed. Freeing `slug`/`domain` on closure and partial unique constraints were both
  refused; neither is needed once returning to a lead is modelled as the sales action it is.
- **The plans are named** `INTERNAL | STARTER | PROFESSIONAL`, as an enum (§3, §5). That is the narrow answer
  that unblocks manual activation. What each plan limits stays open and blocks only quota enforcement.
  `ENTERPRISE` is deliberately absent: a negotiated deal is not a price id.

---

# 10. Open questions

1. **What each plan limits.** The names are settled (§5); the limits are not. PRD §"Example plan limits"
   sketches voice-command counts and realtime access, and PRD §2181 lists it as open. Blocks quota
   enforcement (step 11) and nothing before it.
2. ~~**Accept-and-register**~~ — answered 2026-07-30, §2.5.
3. ~~**Re-provisioning a business that was closed**~~ — answered 2026-07-30, §2.6.1: reopen.
4. **Who picks the slug?** The residue of the original question 3, and still open. The admin picks it at
   provisioning today. It is globally unique and immutable once published, which means a salesperson choosing
   badly on a call has committed the customer to a public URL. Letting the owner choose it at first run would
   fit the pending dashboard (§2.11) — but then provisioning needs a placeholder, and a placeholder that
   escapes into a public link is worse than a hasty choice.
5. **Failed-payment grace period** — how long between `invoice.payment_failed` and `SUSPENDED`.
6. **What status does the seed tenant use?** It currently creates `TRIAL` tenants. With `TRIAL` now reserved
   for a paid-product-free offering, the demo tenant is arguably an internal organization (§2.2) and should
   be `ACTIVE` with an `INTERNAL` subscription. Minor, but it is the first thing a new developer sees.
