This is the manual verification checklist for Epic 9's onboarding and billing path. It closes §6's manual
half and open questions 1 and 2 of
[phase-9-duplicate-subscription-prevention.md](phase-9-duplicate-subscription-prevention.md).

# Phase 9 — Manual test checklist

**Document version:** 1.1 — written 2026-08-02, §M added 2026-08-04. **Not yet walked.**
**Covers:** provisioning → invitation → the pending gate → subscribing → Stripe checkout → activation →
the portal → the lifecycle → degradation → localization and accessibility → giving a provider a login.
**Read first:** [phase-9-duplicate-subscription-prevention.md](phase-9-duplicate-subscription-prevention.md)
§2 and §4 — the design this walk exists to validate.

---

# 1. Why this document exists

The 2026-08-02 slice rewrote how a subscription is sold. A Payment Link is now created **per organization**
at subscribe time rather than held in config per plan, carrying
`restrictions[completed_sessions][limit]=1` and `subscription_data[trial_period_days]`. The four
`STRIPE_PAYMENT_LINK_*` variables are gone.

**None of it has been exercised by a human.** The automated suite stubs Stripe, so it asserts our side of
the contract and can say nothing about whether Stripe actually enforces the one-session limit — which is the
single assertion the whole design rests on (**E2** below). The database and Stripe test mode were both reset
to empty on 2026-08-02, so this walk starts from nothing.

## 1.1 Why this is not automated

There is no `@playwright/test` in the workspace and no e2e harness of any kind. That is a gap, but it is not
the reason this is a manual document.

**E2 and E4 happen on Stripe's hosted checkout page**: a third-party domain, card fields inside iframes, and
no stability guarantee about its structure. Browser automation can drive Stripe test-mode checkout and
plenty of people do — it is also the most brittle thing in any suite that has it, and it is precisely where
the risk sits here. A green automated run against a page Stripe can restructure without warning would be
worse than no run at all, because it would be believed.

If automation is added later, the high-value target is **A–D and F–G** — our side of the boundary, which is
stable because we own it.

---

# 2. Preconditions

| Thing                                                          | State                          | Note                                                                                   |
| -------------------------------------------------------------- | ------------------------------ | -------------------------------------------------------------------------------------- |
| `pnpm dev`                                                     | running                        | 3 apps + a `tsc --watch` per library (11 tasks)                                          |
| `stripe listen --forward-to localhost:3001/v1/webhooks/stripe` | running                        | **Without it nothing activates.** The `whsec_…` it prints must match `STRIPE_WEBHOOK_SECRET` |
| Worker                                                         | running                        | Polls `stripe_events`; the webhook only records (phase-9 §2.9)                            |
| Database                                                       | empty                          | Platform admin survives; there is no seed — provision through `/admin/platform`           |
| Stripe **test** mode                                           | 5 canceled subs, none active   | Live mode is empty and must stay that way                                                 |

**Configured:** `STRIPE_PRICE_STARTER`, `STRIPE_PRICE_PROFESSIONAL`, `STRIPE_SECRET_KEY`,
`STRIPE_WEBHOOK_SECRET`, `REDIS_URL`.
**Defaulted** (absent from `.env`): `TRIAL_PERIOD_DAYS`=30, `ONBOARDING_WINDOW_DAYS`=14,
`INVITATION_EXPIRY_HOURS`=168.

> ### Email delivery is off
>
> `RESEND_API_KEY` and `EMAIL_FROM` are both unset, which the config's `superRefine` treats as "email
> disabled" rather than as an error. Every screen that says **"we have emailed you"** is telling the truth
> about the *request* and not about delivery: an outbox row is written and nothing is sent (tech-impl §12).
>
> **Do not wait for mail.** Take the link from the screen, and assert the outbox row instead.

Hungarian is the default locale on unprefixed URLs; English lives under `/en`.

---

# 3. The checklist

## A. Platform provisioning — `/admin/platform`

- [ ] **A1** Sign in as the platform admin → lands on `/admin` → "Go to the platform dashboard".
- [ ] **A2** Provision form has 7 fields: name, domain, slug, Type (Prospect / Internal), **Language
      (Hungarian / English, defaulting to Hungarian)**, owner name, owner email. Submit as **Prospect**.
- [ ] **A3** Green "Acceptance link" box appears with the URL in a `<code>` block and copy saying it is shown
      once and never stored. **Copy it now** — it is React state only, and navigating away loses it.
- [ ] **A4** The organization appears in the list: amber "Awaiting subscription" badge, "14 days to
      subscribe", Subscription column "None", owner marked "Has not accepted yet".
- [ ] **A5** Provision again with the same slug → red form error `The slug "x" is already taken.`
- [ ] **A6** Same domain, different slug → `An organization already exists for x.`
- [ ] **A7** Owner email = the platform admin's own → 403 *"That user is a platform administrator and cannot
      own an organization."* (rule 9, enforced in both directions).
- [ ] **A8** "Resend invitation" → a fresh acceptance link replaces the box.
- [ ] **A9** *Suspected pre-existing defect — confirm.* Suspend an organization, then Suspend again (or
      Resend after the owner has accepted). The `setStatus` and `resend` mutations have **no `onError`
      handler**, so the 409 produces **no visible feedback at all**. Follow-up ticket, not a blocker.

## B. Invitation acceptance — `/invitations/<token>`

- [ ] **B1** Open the link in a **private window**. Title "Join {organization}", body naming the owner's
      email.
- [ ] **B2** The form has **only Name and Password** — no email field, because the address comes from the
      token.
- [ ] **B3** A password under 12 characters is rejected.
- [ ] **B4** Submit → `role="status"` "You have joined as OWNER" → click **Go to dashboard**. It does *not*
      auto-redirect.
- [ ] **B5** Reopen the same link → "This invitation link is not valid." The same copy covers used, expired,
      revoked and bogus — deliberate, so a probe learns nothing.
- [ ] **B6** Provision a second organization with an email that already has an account → the link shows
      "There is already an account for {email}. Sign in, then open this link again."

## C. The pending gate — `/dashboard`

phase-9 §2.4 calls this "the single most important implementation detail in that document".

- [ ] **C1** Nav shows 7 tabs. **Overview and Subscription are live links; the other five are grey
      `aria-disabled="true"` spans** — not links, not focusable by Tab, not activatable by Enter.
- [ ] **C2** Hint below the tab bar: "Providers, services, locations, availability and bookings become
      available once your subscription starts." Each disabled item points at it via `aria-describedby`.
- [ ] **C3** Panel: "Welcome to {organization}", three numbered steps with step 1 highlighted, and
      **"14 days left to subscribe."**
- [ ] **C4** The "Subscribe" call to action goes to `/dashboard/subscription`.
- [ ] **C5** *Known gap.* Type `/dashboard/providers` directly. The page loads — there is no route guard,
      only client-side rendering — and the API 403s.
- [ ] **C6** Provision an **Internal** organization: no countdown line at all, not "0 days".

## D. Subscribe — the per-tenant link ★

**The heart of the change.** D5–D7 are new behaviour with no precedent in the product.

- [ ] **D1** Screen shows "30 days free. We take your card now but charge nothing until the trial ends…" and
      both plans as radio buttons.
- [ ] **D2** Choose Starter → button reads **"Start my free trial"**. The browser is **not** redirected: the
      form is replaced by "We have emailed the payment link to {email}" and a **"Start the free trial"**
      button that opens in a new tab.
- [ ] **D3 — Stripe side.** `stripe payment_links list --limit 3`. The newest must carry
      `restrictions.completed_sessions.limit = 1`, `metadata.tenantId` = the organization id, and
      `subscription_data.trial_period_days = 30`.
- [ ] **D4 — our side.** Exactly one `subscription_checkout_links` row for the tenant, `consumed_at` null,
      `trial` true, `url` carrying `?client_reference_id=<tenantId>`.
- [ ] **D5 — the one-link proof.** Reload the page (the `sent` state is client-only, so the form returns) and
      submit again. **The returned `paymentUrl` must be byte-identical**, Stripe must still show one link for
      this tenant, and there must still be exactly one row.
      *This is the scenario that produced the incident: under the old code every click minted a new link.*
- [ ] **D6 — the race.** Open the screen in two tabs and submit both as close together as you can. Still one
      link, one row. The loser goes through the `P2002` path and deactivates the link it created — confirm no
      orphaned **active** link is left in Stripe.
- [ ] **D7 — plan change before paying.** Reload, choose **Professional**, submit. The Starter link must be
      `active: false` in Stripe, the row replaced, and a new URL returned.
- [ ] **D8** An outbox row `SUBSCRIPTION_LINK_REQUESTED` exists. **No email arrives** — see §2.

## E. Stripe checkout ★★ — the assertions nothing else can make

- [ ] **E1** Open the payment link. Pay with `4242 4242 4242 4242`, any future expiry, any CVC, any postcode.
- [ ] **E2** **Reopen the exact same URL. Stripe must refuse it.**
      ← *This is open question 1, and everything in §4 of the duplicate-prevention record is contingent on
      it. If a second checkout completes, the design is wrong and needs rewriting rather than patching —
      stop the walk and report.*
- [ ] **E3** Note the copy on the refusal page. We set `inactive_message` pointing the owner back at their
      dashboard; whether Stripe renders it for a **restriction-exhausted** link, as opposed to a manually
      deactivated one, is **open question 2** and untested.
- [ ] **E4** In Stripe: the subscription is `trialing`, **no charge was taken**, and a card is on file.
- [ ] **E4a** Completing the payment **redirects back to `/dashboard/subscription`** rather than stopping on
      Stripe's own confirmation page (`after_completion`). For the English organization of §L the destination
      is `/en/dashboard/subscription`.
- [ ] **E4b** *Known and accepted, not a defect.* The payment page itself follows the **browser's** language,
      not the organization's — `paymentLinks.create` has no `locale` parameter. Test it by changing your
      browser's preferred language, not by provisioning a different organization. See
      [phase-9-owner-language-and-return-paths.md](phase-9-owner-language-and-return-paths.md) §5.2.
- [ ] **E4c** *Not a locale problem.* If the confirmation reads "a payment to **Stripe** will appear on your
      statement", the account's statement descriptor is unset (Dashboard → Settings → Business → Public
      details). It will read that way on real owners' bank statements (§5.3).
- [ ] **E5** The subscription carries `metadata.tenantId`. *(All five pre-existing subscriptions had none —
      this is new, and §4.3 depends on it.)*

## F. Activation

- [ ] **F1** `stripe listen` shows `checkout.session.completed` and `customer.subscription.created`.
- [ ] **F2** Worker logs `stripe: checkout bound to organization`, then `stripe: subscription mirrored`.
- [ ] **F3** Database: subscription row with the subscription id, customer id and price id, status
      `TRIALING`, `trial_ends_at` ≈ +30 days, `trial_used_at` stamped; tenant `TRIAL` with `subscribe_by`
      **null**; the checkout-link row's `consumed_at` **stamped**.
- [ ] **F4** Subscription screen flips to "You are subscribed to Starter." + "Your free trial ends on
      {date}." + "Your trial is active — everything is unlocked."
- [ ] **F5** All 7 nav tabs are live links and the hint line is gone.
- [ ] **F6 — the post-payment guard.** Submit subscribe once more → 409 *"This organization already has a
      subscription."*
- [ ] **F7 — the guard that does not need the webhook.** Provision a **second** organization, subscribe,
      **stop the worker**, complete checkout, then submit subscribe again. Expect 409 *"This organization has
      already paid. Its subscription is being activated…"* with **zero** subscription rows in the database.
      *This is §4.4: the refusal comes from `checkout.sessions.list`, not from a row we own.*

## G. Ordering and duplicate resilience

- [ ] **G1 — out-of-order events.** Worker stopped, complete a checkout, then start the worker. Both events
      process regardless of arrival order, because the subscription now carries `metadata.tenantId` (§4.3).
      No `OrphanEventError` for this subscription in the logs.
- [ ] **G2 — duplicate detection.** Force a second subscription for a tenant that already has one: create a
      Payment Link by hand in the dashboard, append that tenant's `client_reference_id`, and check out.
      Expect the **first** subscription kept, an audit row `billing.duplicate_subscription_detected` naming
      both ids, an `error`-level log, and the event marked **processed** rather than failed (§5.1).
- [ ] **G3 — foreign subscription.** Create a subscription by hand with no `client_reference_id`. Expect
      `OrphanEventError`, retries, then `stripe: event names a subscription we never recorded; giving up`
      after `STRIPE_EVENT_ORPHAN_TIMEOUT_MS` (15 minutes).

## H. Customer portal

- [ ] **H1** "Manage billing" → **same-tab** redirect. Deliberately not a new tab: the session expires within
      minutes and one left in a background tab is dead by the time anyone returns to it.
- [ ] **H2** Change the card. **H3** Open an invoice. **H4** Cancel the subscription.
- [ ] **H5** Returning from Stripe lands back on `/dashboard/subscription` — and on
      `/en/dashboard/subscription` for the English organization of §L.
- [ ] **H5a** The portal itself renders in the organization's language (`locale` is sent, §5.1). Confirm it on
      the **English** organization using a **Hungarian** browser: that combination is the one that proves our
      value is winning rather than the browser's.
- [ ] **H6** After cancelling in the portal the screen says **"Ends on {date}"**, not "Renews on".
      *Read [phase-9-customer-portal.md](phase-9-customer-portal.md) §3 first — a portal cancellation may
      report `cancel_at` rather than `cancel_at_period_end`, and reading only the boolean fails silently and
      completely: the owner cancels, Stripe agrees, and our screen goes on saying "renews on" until the day
      the organization is suspended without warning.*
- [ ] **H7** On the Internal organization "Manage billing" is still shown — `portalAvailable` reflects only
      our config — but 409s with "This organization has no subscription to manage yet."

## I. Lifecycle

- [ ] **I1** Upgrade Starter → Professional in the portal: **immediate**, prorated, screen updates.
- [ ] **I2** Downgrade Professional → Starter: **deferred to renewal**, and the screen says "Your plan
      changes to Starter on {date}." (`subscription_schedule.*` mirrored — §2.4 of the lifecycle record).
- [ ] **I3** `stripe trigger customer.subscription.trial_will_end` → a `TRIAL_ENDING_SOON` outbox row.
- [ ] **I4** `invoice.payment_failed` → status `PAST_DUE`, amber notice on screen, and **access retained**.
      Stripe's own dunning is the grace period (§2.3).
- [ ] **I5** Delete the subscription → tenant `SUSPENDED`, never `CLOSED`, and the subscription screen stays
      reachable so the owner can fix it.
- [ ] **I6 — no second trial.** From the cancelled organization, subscribe again. Copy must read **"This
      organization has already used its free trial, so billing starts straight away."**, the button must say
      **"Send me the payment link"**, and the created link must have **no** `trial_period_days`.

      > **This one is genuinely unknown, so observe rather than assume.** F6's widened guard refuses on *any*
      > non-null `stripeSubscriptionId`, and a cancelled subscription keeps its id — so the returning
      > customer may be refused here instead. The automated tests pin down each behaviour separately and say
      > nothing about which wins. Whatever happens, record it: if the guard refuses, resubscription has to go
      > through the portal, and the copy above is unreachable and should be deleted.

## J. Degradation and config

- [ ] **J1** Unset `STRIPE_SECRET_KEY` and restart: "No plans are available right now.", no portal button,
      subscribe 503s — and nothing else in the app breaks (rule 4).
- [ ] **J2** Unset `STRIPE_PRICE_STARTER` only: just Professional is offered.
- [ ] **J3** *Suspected pre-existing defect — confirm.* With **only** Professional configured, the radio
      group renders one unchecked option while local state still defaults to `STARTER`
      ([subscription-screen.tsx:50](../apps/web/src/components/subscription-screen.tsx#L50)), so submitting
      posts `STARTER` → 404 "The STARTER plan is not available."
- [ ] **J4** *Minor.* The error string is not cleared when the plan radio changes, only on submit.

## K. Localization and accessibility

- [ ] **K1** Walk the whole flow once on `/en`; spot-check Hungarian on the unprefixed URLs.
- [ ] **K2** *Known gap.* Every API error (409 / 404 / 503) renders **in English regardless of locale** —
      the messages come from the server, which has no locale.
- [ ] **K3** *Known gap.* Dates use `toLocaleDateString()` with no locale argument, so they follow the
      **browser** locale rather than the app's.
- [ ] **K4** Screen-reader pass on the pending dashboard: disabled nav items announce as disabled and read
      the gate reason.
- [ ] **K5** `role="status"` on the acceptance link, the payment-link confirmation and the plan-change line;
      `role="alert"` on errors and the past-due notice.

## L. The English organization ★

The pass that would have caught the whole of
[phase-9-owner-language-and-return-paths.md](phase-9-owner-language-and-return-paths.md). Everything above
runs against a Hungarian organization, and Hungarian is the default locale — whose URLs carry **no prefix**.
So a link built with no locale at all is indistinguishable from a correct one until an English organization
exists. Provision one and repeat the path.

- [ ] **L1** Provision with **Language: English** (A2). The row is created with `default_language = 'en'`.
- [ ] **L2** The **invitation email** arrives in English *and* its acceptance link is
      `/en/invitations/<token>`. Opening it shows the English landing page directly, with no locale redirect.
- [ ] **L3** The **payment-link email** is English and its `billingUrl`-style links carry `/en`.
- [ ] **L4** Subscribe → the emailed Stripe link works; after paying you land on
      `/en/dashboard/subscription` (E4a).
- [ ] **L5** The **confirmation email** is English and its dashboard link is `/en/dashboard`.
- [ ] **L6** "Manage billing" opens Stripe's portal **in English** and returns to `/en/dashboard/subscription`
      (H5, H5a).
- [ ] **L7** Repeat L1 with Language left at **Hungarian** and confirm the links have **no** prefix. Both
      directions matter: a helper that prefixed unconditionally would pass L2–L6 and break every existing
      organization.

## M. Provider onboarding — giving a provider a login

[phase-9-provider-onboarding.md](phase-9-provider-onboarding.md). Needs an **ACTIVE** organization, so run
this after F. Create a service first, then a provider — the screen refuses to be useful without one.

The point of the whole section is **M6**: the membership must come out already linked to the diary. Every
other check is a way that can silently not happen.

- [ ] **M1** Providers → a provider row carries an **Invite** button beside Edit / Assign / Availability.
      Signed in as an ASSISTANT, it is absent (it asks for `member:manage`, not `provider:manage`).
- [ ] **M2** Press it. The panel names **the address on the provider record**, and there is no email field —
      the address is not the caller's to choose (§2.4).
- [ ] **M3** Submit → `role="status"` "Invitation sent to …". The acceptance link is **not** on screen until
      you open **Show the link instead**; that disclosure is the escape hatch for the delivery-off case in
      §2 above, not the mechanism (§2.6).
- [ ] **M4** The email arrives in the organization's language, names who invited them, says **no password is
      coming**, and its link carries `/en` for an English organization. It must *not* offer to add services
      or staff — a provider has no such screens (§2.8).
- [ ] **M5** Open the link in a **private window**. The heading reads "Join {organization} as {provider}",
      naming the diary — which is how somebody notices they were sent the wrong person's link before
      accepting it. Only Name and Password; under 12 characters is rejected.
- [ ] **M6** Accept → the button reads **Set up my working hours** and lands on `/dashboard/availability`,
      with **their own diary already selected and no provider picker**. ★ Confirm in the database that the
      membership has `role = 'PROVIDER'` **and** a non-null `provider_id`. A null here is the entire bug this
      work exists to remove, and every screen still looks fine.
- [ ] **M7** Their navigation shows exactly **Overview, Bookings, Availability** — not Subscription, Services,
      Locations or Providers (§2.9).
- [ ] **M8** Set working hours and save. Then edit the URL to another provider's id: expect **403**, not a
      rendered screen. The API decides, not the picker.
- [ ] **M9** Back as the owner, the same row's button now reads **Resend invitation**. Press it, and confirm
      the **first** link is now dead ("This invitation link is not valid.") while the second works (§2.5).
- [ ] **M10** Correct the provider's email on the Edit panel, then invite again. It succeeds, and there is
      exactly one PENDING invitation for that provider — the old address's one was superseded too.
- [ ] **M11 — the race.** Invite provider X. *Before* accepting, invite a second person as a plain PROVIDER,
      accept as them, and link them to X on the members list. Now accept the first link: expect a clear 409
      ("Someone else has already been given this provider's login"), **no** membership for the first person,
      and — check the database — the invitation still `PENDING`. Unlink the second person and the original
      link works again with no reissue (§2.7).
- [ ] **M12** Archive a provider, then press Invite by URL: 404. Invite, *then* archive, *then* accept: 409
      naming the provider as no longer active, invitation still PENDING.
- [ ] **M13** *Known gap, expected.* A provider created before 2026-08-04 may have no email address. Its
      Invite button is present but disabled, with the reason spelled out under the table rather than left to
      be guessed (§7.1).
- [ ] **M14** *Side effect worth confirming.* Sign in as an **ASSISTANT**: their navigation is now Overview
      and Bookings only, having lost four items they could never act on. Outside this feature's scope and
      recorded in §2.9 rather than left to be discovered.
- [ ] **M15 — the trap that was found by walking, not by testing (§2.11).** On **Overview → Invite
      someone**, the role dropdown offers OWNER, ADMIN and ASSISTANT and **not PROVIDER**, with a notice
      pointing at Providers. Then try it anyway with `curl` or the API docs: `POST /v1/members/invitations`
      with `role: "PROVIDER"` must return **422**, naming the Providers screen. A membership created this
      way can do nothing and says nothing about why, which is the whole reason §M exists.
- [ ] **M16** The members table has a **Diary** column: the provider's name for a linked member, an em dash
      for an owner or assistant, and — for a PROVIDER holding none — a select of unlinked providers.
      Picking one links them; their own navigation gains **Availability** on their next load. This is the
      repair for anyone stranded before M15 existed, and the reason the invite route's "already a member"
      message is now true.

---

# 4. Commands

```bash
stripe listen --forward-to localhost:3001/v1/webhooks/stripe
stripe payment_links list --limit 5
stripe payment_links retrieve plink_xxx      # restrictions, metadata, subscription_data
stripe subscriptions list --limit 20 --status all
stripe checkout sessions list --limit 20     # client_reference_id per session
stripe trigger customer.subscription.trial_will_end
```

**Test cards** — `4242 4242 4242 4242` succeeds · `4000 0000 0000 9995` is declined ·
`4000 0000 0000 0341` attaches successfully and then fails on a later payment, which is what **I4** needs.

**Reset between runs** — cancel the subscription in Stripe *first*, so `customer.subscription.deleted` has a
tenant to belong to, then `pnpm db:discard-organization <slug> --yes`. The other order leaves an event
naming a tenant that no longer exists.

> **Never run any of this against live mode.** The Stripe CLI defaults to test. The MCP connector is wired
> to **live** and must not be used for any of it — it will refuse test-mode object ids, which is the
> cheapest possible way to find out you are pointed at the wrong one.

---

# 5. What ticking these boxes closes

| Closes                                                            | By      |
| ----------------------------------------------------------------- | ------- |
| §6 tests 7–10 of the duplicate-prevention record                  | D3, E1–E5, F3 |
| Open question 1 — does `completed_sessions.limit` hold?           | E2      |
| Open question 2 — is `inactive_message` shown when exhausted?     | E3      |

When the walk is done, update the duplicate-prevention record's version line, which currently reads
"**§6's manual half not yet walked against Stripe**".

**A9, C5, J3 and J4 are pre-existing defects this walk is likely to confirm.** They belong in a follow-up
section rather than being fixed mid-walk — changing code halfway through invalidates the boxes already
ticked.
