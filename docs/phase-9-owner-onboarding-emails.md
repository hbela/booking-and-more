This is the execution record for the seventh slice of Epic 9 — closing the owner's onboarding path so that
every step of it arrives by email, and fixing the reason none of them did.

# Phase 9 — Owner onboarding emails

## Implementation Record

**Document version:** 1.0 — built 2026-08-02, automated tests green, **not yet walked against a live inbox**.
**Scope:** why configured email delivered nothing, the notification status that lied about it, and the
confirmation email the flow was missing.
**Depends on:** [phase-5-notifications.md](phase-5-notifications.md) for the outbox → notification → job
chain, [phase-9-saas-administration.md](phase-9-saas-administration.md) §2.5 for the invitation email, and
[phase-9-subscription-and-activation.md](phase-9-subscription-and-activation.md) §3.2 for the payment link.
**Exit criteria:** An owner receives their acceptance link without anybody copying it by hand · They receive
the payment link · They receive a confirmation once the subscription is live · A notification that was not
delivered never says it was

---

# 1. What was actually wrong

Nothing in the code, and nothing in the Resend account.

The report was "I have `RESEND_API_KEY` and `EMAIL_FROM` set, but no email is sent". Both were true. The key
was valid and `tanarock.hu` was verified. Five notification rows existed, all `status: SENT`, `attempts: 1`,
`lastError: null`.

They also all had **`provider_message_id: null`**, which is the only place the truth was recorded.

`getEmailProvider` memoises the provider on first use, and `loadEnvOrExit()` reads the environment at module
load. The worker had been started before the keys were added, so it was holding `createLoggingProvider` —
which writes the message body to the log and returns `{ ok: true }`. Every notification since had been
marked sent by a provider that sends nothing.

**The fix for the immediate problem is to restart the worker.** The rest of this document is about why that
was hard to find, and what was missing once it worked.

---

# 2. A provider that does not deliver must not report success

## 2.1 The failure this reintroduced

`billing.service.ts` refuses to send email inline, and says why:

> the predecessor did exactly that and swallowed the failure, so an owner who never received their link
> looked identical to one who did

The logging provider reintroduced precisely that, one layer further down. An owner who never received their
invitation was indistinguishable — in the database, in the dashboard, in any query anyone would think to
write — from one who did. The distinguishing column existed and was null, which is not a signal anybody
reads.

That it was introduced *by* rule 4 is the interesting part. "A missing API key must degrade one feature,
never crash boot" is right, and `createLoggingProvider` is the correct shape for it. The error was in
`{ ok: true }`: degrading gracefully is not the same as claiming to have succeeded.

## 2.2 The fix

`EmailProvider` gains `readonly delivers: boolean` — false for the logging provider, true for Resend. The
sender checks it before recording anything:

```ts
if (result.ok && !options.provider.delivers) {
  // status: SKIPPED, lastError: "no email provider configured; body written to the log"
}
```

**`SKIPPED`, not `FAILED`**, for the same reason a missing template is skipped: retrying cannot fix it, and
the dead-letter queue should mean something. **The message is still handed to the provider first**, because
writing the body to the log is the entire purpose of running without a key.

**The payload is deliberately not cleared** on this path, unlike on a real send. The comment on
`Notification.payload` explains that the invitation token is cleared once the email is away, to bound its
exposure — but when nothing was sent, the token in that column is the only copy anyone has.

The boot warning now says what it means, and names the restart:

> `RESEND_API_KEY/EMAIL_FROM not configured — nothing will be delivered. Messages are written to this log
> and their notifications recorded SKIPPED. Set both and restart the worker.`

## 2.3 What this does not fix

`getEmailProvider` still memoises, and env is still read once at module load. Configuring a key while the
worker runs still requires a restart. That is correct — rule 3 puts environment parsing at the edge, and a
process that re-reads its configuration mid-flight is a different and worse problem — but it is now said out
loud in the one place somebody will be looking.

---

# 3. The confirmation email

## 3.1 What was missing

Two of the three emails already existed and had simply never been delivered:

| Email                  | Type                   | Template               | Carries             |
| ---------------------- | ---------------------- | ---------------------- | ------------------- |
| Acceptance link        | `ORGANIZATION_CREATED` | `organization-created` | `acceptUrl`, expiry |
| Payment link           | `SUBSCRIPTION_LINK`    | `subscription-link`    | `paymentUrl`        |
| **Subscription live**  | —                      | —                      | **did not exist**   |

So the owner accepted an invitation, paid on Stripe's hosted page, and heard nothing from us again. **That
is the one moment in onboarding where silence reads as failure**, because they have just handed over a card.
Stripe sends its own receipt, but that confirms a *payment*; nothing confirmed that the thing they bought
was ready, and nothing pointed them at it.

## 3.2 Keyed on the subscription, not the event

Every other tenant notification dedupes on the outbox event id. This one cannot, and it is the only one in
the file that differs.

A subscription goes live once but **reports itself many times**: `customer.subscription.updated` fires for a
card swap, a plan change, a renewal, and every one of them carries a live status. Keyed on the event, the
confirmation would congratulate the owner every time they touched their billing settings.

Keyed on `sub_…` it is sent once per Stripe subscription, ever — and a customer who cancels and comes back
still gets a fresh one, because that is a new subscription with a new id. Which is right: they did subscribe
again.

## 3.3 Two guards, for the usual reason

`mirrorSubscription` emits the outbox event only on the **transition** into a live status — the stored status
was not live, the incoming one is. That keeps the outbox clean.

It does not make the guarantee. The read-then-write has a window in it, and what actually guarantees one
email is the unique index on `(tenant_id, dedupe_key)` (rule 14). The transition test is an optimisation;
the constraint is the rule.

## 3.4 The charge line is the point

The template names the date the money moves, and during a trial it says that cancelling before then costs
nothing.

Same reasoning as the trial-ending email, applied earlier: a charge nobody expected is the commonest reason
a new customer disputes one, and the cheapest place to prevent that is the email they are most likely to
actually read — the one that arrives while they are still paying attention.

When Stripe names no date the line is **dropped entirely** rather than guessed at. "You will be charged on "
is worse than saying nothing about dates, and a fabricated date is a commitment we would be held to.

---

# 4. What was built

| Thing                                                        | Where                                             |
| ------------------------------------------------------------ | ------------------------------------------------- |
| `EmailProvider.delivers`, and both providers declaring it    | `apps/worker/src/email/email.provider.ts`         |
| Sender records `SKIPPED` for a non-delivering provider       | `apps/worker/src/notifications/notification.sender.ts` |
| `SUBSCRIPTION_CONFIRMED` enum value + migration              | `packages/db/prisma/schema.prisma`                |
| Type, dedupe variant, template name                          | `packages/notification-engine/src/{types,dedupe,planning}.ts` |
| `renderSubscriptionConfirmed`, hu and en                     | `packages/notification-engine/src/templates.ts`   |
| `dispatchSubscriptionConfirmed`                              | `apps/worker/src/outbox/outbox.dispatcher.ts`     |
| Emission on the transition into a live status                | `apps/worker/src/stripe/stripe.processor.ts`      |

Tests: the sender no longer records `SENT` for a non-delivering provider; the dedupe key collides across
later events and separates across resubscription; the template names the charge date during a trial, calls
it a renewal once paying, and drops the line when there is no date; the processor emits once on transition
and not at all on a later change.

---

# 5. Verification

Automated — green. `pnpm lint`, `check-types`, `db:drift-check` clean.

Manual, **not yet done** — this needs a live inbox and belongs with
[phase-9-manual-test-checklist.md](phase-9-manual-test-checklist.md):

1. Restart the worker with the keys set. The boot warning must be **absent**.
2. Provision an organization. The owner receives the acceptance link **without anybody copying it**, and the
   notification row has a non-null `provider_message_id`.
3. Subscribe. The owner receives the payment link.
4. Complete checkout. The owner receives the confirmation, naming the trial's end date and the fact that
   cancelling before it costs nothing.
5. Change the card in the portal. **No second confirmation arrives** — §3.2's whole point.
6. Unset the keys and restart: notifications record `SKIPPED`, bodies appear in the log, nothing claims to
   have been sent.

Note that all five existing notifications were sent in **Hungarian** — `resolveLocale` reads the tenant's
`defaultLanguage`, which provisioning defaults to `hu` and the platform screen never asks about. Whether an
owner's language should be a question on the provisioning form is a real one, and is not answered here.

---

# 6. Open questions

1. **Should the five notifications already recorded `SENT` be corrected?** They were not delivered and the
   rows say they were. They are development data and will be discarded, but the same situation in production
   would need a backfill — and there is no way to distinguish them except `provider_message_id IS NULL`,
   which is also true of any future non-delivering provider.
2. **Should provisioning ask for the owner's language?** See above. Today every owner gets Hungarian unless
   somebody edits the tenant afterwards.
3. **Should a `SKIPPED` notification be retried once a provider is configured?** Currently not: `SKIPPED` is
   terminal. The alternative is a sweep that revives them, which risks emailing a stale invitation link long
   after it expired.
