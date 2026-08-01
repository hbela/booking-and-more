This is the execution record for one slice of Epic 9, derived from
[phase-9-saas-administration.md](phase-9-saas-administration.md) §8 step 6.

# Phase 9 — Owner onboarding

## Implementation Record

**Document version:** 1.0 — built and tested 2026-07-30.
**Scope:** the owner's path from a provisioned organization to a signed-in session — accept-and-register, the
invitation landing page, and the development script that makes the loop repeatable. **Billing is out of
scope.**
**Depends on:** [phase-9-saas-administration.md](phase-9-saas-administration.md) for the decisions this
implements — §2.5 (A2, accept-and-register), §2.6.1 (why re-provisioning a domain is blocked), §2.11 (the
pending dashboard, deliberately _not_ built here) — and CLAUDE.md rule 7 for why the cleanup is a script
rather than a route.
**Exit criteria:** A brand-new owner can go from the emailed link to a signed-in dashboard in one form · The
invited address is the only address that can be registered from a given token · The same organization can be
provisioned, accepted and discarded repeatedly without touching the database by hand

---

# 1. Context

The flow in [phase-9-saas-administration.md](phase-9-saas-administration.md) §1.4 works from provisioning
through to the invitation email. It then stops at step 4.

`POST /v1/members/accept` requires a session and matches the invited address against it. A brand-new owner
has neither. What the code actually does today: the link opens, `accept-invitation.tsx` finds no session and
renders `needs-sign-in`, which pushes to `/sign-in`. There is no account there. The owner has to discover
`/sign-up` unaided, register with the exact address the invitation was issued to, and then find their way
back to a link that is sitting in an email they have already navigated away from.

Four steps, one of them undiscoverable, at the moment the product makes its first impression on somebody who
has just agreed to pay for it.

§2.5 settled the fix as **A2**: one unauthenticated route takes the token and a chosen password and returns
an account, a membership and a session. The argument for it is that the invitation token is _already_ proof
of control of that mailbox — which is exactly the thing a registration flow would otherwise send a
verification email to establish. So there is no new trust assumption to make, only a step to delete.

## 1.1 What this deliberately does not do

The owner will land on `/dashboard` in `PENDING_SUBSCRIPTION`, and every write will be refused by
`requireWritableTenant`. That is correct and it stays.

The navigation will still render six clickable links that 403. That is a real defect, it is §2.11's B2
decision, and it is **not** fixed here — mixing it in would make this change impossible to review as one
thing. Anyone testing this plan's output should expect the 403s and not treat them as a regression.

**Fixed since, on 2026-07-30**, in
[phase-9-subscription-and-activation.md](phase-9-subscription-and-activation.md): the gated items are now
`aria-disabled` spans with a shared explanation, and the overview carries a three-step panel whose one live
action is Subscribe.

---

# 2. Decisions

## 2.1 The invited address is the only address the route will register

The single security property of `accept-and-register`, and the one thing about it worth being paranoid over.

The email is read **from the invitation row**, never from the request body. A route that accepted an email
alongside the token would let anyone holding a leaked token create an account at an address of their
choosing and take the membership with it — turning a link that was only ever a claim about one mailbox into
a general-purpose grant.

The request body carries a name and a password. Nothing else about identity is caller-supplied.

## 2.2 The new user is created already verified

Better Auth is configured with `requireEmailVerification: false` today, for a stated reason: there was no way
to deliver mail, so requiring it would have locked every new account out. That reason is expiring — Epic 5
part 2 can now send.

Rather than leave the new owner in an unverified state that a future flip of that flag would lock out, this
route sets `emailVerified: true` explicitly. It is not a shortcut: the owner demonstrably received mail at
that address, because the token they just used only ever existed inside it. This is the same reasoning that
makes the whole A2 decision safe, applied to the user row.

## 2.3 A lookup route, because a bare password form is a bad first impression

The page needs the organization's name before the owner types a password — "join Wellness Kft." rather than
"choose a password" with no indication of what for. The alternative considered was rendering the form blind
and discovering everything on submit, which is less code and a worse screen.

`POST /v1/invitations/lookup`, with the **token in the body rather than the path**. This matters and is the
reason it is a POST for what is logically a read: a token in a URL is written to every access log, proxy log
and browser history along the way. The existing accept route already puts it in the body; this follows.

It reveals the invited address and the organization name to a caller holding the token. That is not an
enumeration risk — the caller must already hold 32 bytes of CSPRNG output that names that specific
invitation — and it is information the resulting email already contained.

It also answers `requiresRegistration`, so the page can send somebody who already has an account to sign-in
rather than to a form that will refuse them.

## 2.4 User creation cannot join the membership transaction, and that is survivable

Better Auth owns the user row, so `signUpEmail` is a call, not something that can be enlisted into
`prisma.$transaction`. The sequence is therefore: validate → refuse if the address is taken → create the user
→ transactionally create the membership and mark the invitation ACCEPTED.

If the last step fails, a user exists with no membership. The recovery is already in the flow and needs no
new code: the invitation is still `PENDING`, and the owner now has an account whose password they just chose,
so re-opening the link takes the "address already taken" branch, which points them at sign-in and the
ordinary `/v1/invitations/accept`.

The alternative — writing Better Auth's tables directly to get atomicity — trades a recoverable rare state
for a permanent second source of truth about identity. That is the mistake CLAUDE.md's identity-vs-
authorization section exists to prevent.

## 2.5 The ordinary accept route stays

`POST /v1/invitations/accept` is not replaced. It is the path for an invitee who already has an account —
a colleague being invited to a second organization, which is the case rule 9's "same person can own one
clinic and assist at another" is about. `accept-and-register` is for the person who has no account, which in
the onboarding flow is every owner.

Two routes, two clearly different preconditions, each with one job.

## 2.6 Discarding a test organization is a script, never a route

Re-provisioning `wellness.hu` after testing is blocked by the unique constraints on `slug` and `domain` —
the same obstacle §2.6.1 solves for production with `reopen`. Development needs the blunter version: actually
remove it.

That is a script. **CLAUDE.md rule 7 — no debug endpoints, in any environment** — and a route that deletes
tenants is the most dangerous possible instance of the thing that rule exists to forbid. A predecessor
shipped `/debug/db-info` to production; a `/debug/delete-tenant` would be worse by a wide margin.

The script also has to delete the owner's **user** row, not only the tenant, or the second run of the loop
hits "that address already has an account" and the flow under test cannot be re-entered.

**The trap in that, stated here because it is the one thing in this plan that can destroy real access:** the
natural predicate is "users with no remaining memberships". A platform admin holds no memberships _by
design_ (rule 9). That predicate deletes the operator account running the test. The script must exclude
`isPlatformAdmin` explicitly, and a test of the script is not what catches this — reading it is.

---

# 3. API surface

Both join the existing `invitationAcceptRoutes` plugin, already mounted at `/v1/invitations` outside the
tenant-scoped tree, because whoever is accepting is by definition not yet a member of anything.

```text
POST /v1/invitations/lookup               unauthenticated · rate-limited
     { token }
  →  { organizationName, email, role, expiresAt, requiresRegistration }

POST /v1/invitations/accept-and-register  unauthenticated · rate-limited
     { token, name, password }
  →  { tenantId, role }  + session cookie

POST /v1/invitations/accept               unchanged — for an invitee who already has an account
```

Schema-first per rule 2. Rate limit `{ max: 10, timeWindow: "1 hour" }` on the new pair, matching the
existing accept route: the token is unguessable, but the limit closes off bulk probing.

`accept-and-register` forwards Better Auth's `Set-Cookie` headers, **appended rather than set** — sign-up
emits several and `Headers` collapses them into one comma-joined value otherwise. `auth.plugin.ts` already
documents this trap at its own bridge; this is the second place it applies.

Audited as `membership.invitation_accepted_with_registration`, distinct from the ordinary acceptance,
because it also created a user.

---

# 4. Web

`accept-invitation.tsx` gains states rather than being rewritten:

```text
checking ──▶ lookup ──▶ registering ──▶ accepted
                │
                ├──▶ needs-sign-in     (account exists, or already signed in as someone else)
                └──▶ failed
```

- The lookup runs regardless of session state — the organization's name is wanted in every branch.
- Signed out, no account → name and password, headed with the organization and the invited address.
- Signed out, account exists → the sign-in prompt, now able to say _which_ address to sign in as.
- Signed in → today's behaviour, unchanged.

After success the session cookie exists but `useSession` does not know it, so it must be refetched before
navigating, or `/dashboard` renders as signed out.

Localization keys go into the `invitation` namespace in **both** `en.json` and `hu.json` — next-intl throws
on a missing key rather than falling back, so a one-language change breaks the other language's build.

---

# 5. Verification

The point of the exercise is to prove `outbox → notification → template → provider` without Resend existing.

1. `docker start bam-redis`. Not optional: `attachQueues` only runs when `REDIS_URL` is set, and it is what
   starts the outbox poller. No Redis means no notification row and no logged email.
2. Comment out **both** `RESEND_API_KEY` and `EMAIL_FROM`. `@bam/config` refuses one without the other, so
   commenting out only the key fails validation at boot for the API and the worker. With both gone,
   `getEmailProvider` returns the logging provider.
3. `pnpm dev`. The worker should report `emailProvider: "logger"`.
4. Provision a PROSPECT organization at `/platform`. The accept URL appears in the UI once, and the rendered
   email appears in the worker log within a poll interval. **They must match** — that is the assertion.
5. Open the URL in a private window. Expect the organization name, the invited address, and one form.
6. Submit. Expect `/dashboard`, signed in, organization selected, writes refused with 403 (§1.1).
7. `pnpm db:discard-organization <domain> --yes`, then provision the same domain again. Confirm the
   platform-admin account survived (§2.6).

---

# 6. What was built

| Piece                                      | Where                                                          |
| ------------------------------------------ | -------------------------------------------------------------- |
| `findValidInvitation`, `claimInvitation`   | `membership.service.ts` — extracted, shared by all three paths |
| `describeInvitation`                       | `membership.service.ts`                                        |
| `registerAndAccept`                        | `membership.service.ts`                                        |
| `POST /v1/invitations/lookup`              | `membership.routes.ts`                                         |
| `POST /v1/invitations/accept-and-register` | `membership.routes.ts`                                         |
| The landing page's three arrivals          | `accept-invitation.tsx`                                        |
| `hu`/`en` copy                             | `messages/{en,hu}.json`, `invitation` namespace                |
| `pnpm db:discard-organization`             | `packages/db/scripts/discard-organization.ts`                  |
| 10 integration tests                       | `apps/api/src/onboarding.test.ts`                              |

## 6.1 Deviations from the plan, and details worth knowing

- **`registerAndAccept` takes a `createUser` callback rather than the Better Auth instance.** The service
  layer has no business holding an HTTP-shaped dependency, and the route already has `app.auth`. It also
  means the service's tests can drive it without standing up Better Auth.
- **Validation failures are 422, not 400.** `ValidationError` in `@bam/contracts` carries 422 and the error
  handler uses it for schema failures. The first draft of the test asserted 400 and caught this.
- **`Field` is now exported from `auth-form.tsx`.** Choosing a password is the same act on both screens, and
  a second set of inputs would have drifted in styling and in `aria-describedby` wiring.
- **`MeResponse.tenant.status` in the web client was missing `PENDING_SUBSCRIPTION`** — the API has returned
  it since provisioning landed. Fixed here because this is the flow that puts a user in that state.
- **The lookup runs even for a signed-in visitor.** It costs one request and means the heading can name the
  organization in every branch rather than only for new accounts.

## 6.2 A test-writing trap this hit

The first version of "refuses a short password" asserted `findFirst({ where: { name: "Anna" } })` was null.
It matched a user a _different_ test had just created — integration suites share one database and run in
parallel, which is why every other identifier in that file is suffixed with `RUN`. Assertions about absence
have to be scoped as narrowly as assertions about presence; the corrected version looks up the specific
invited address.

---

# 7. Open questions

1. **Should the invitation email name the organization in its subject?** The template renders it in the body
   already. Not blocking.
2. **Does `INVITATION_EXPIRING` (§6 of the epic doc) change with A2?** The warning was designed for a flow
   where the link was hard to use. It is still needed — the link still expires — but its copy assumes the
   old two-step path.
3. **Should `accept-and-register` be rate-limited per token rather than per IP?** It is currently
   `{ max: 10, timeWindow: "1 hour" }` like its neighbours. A shared corporate NAT could in principle
   exhaust that for colleagues accepting invitations to the same organization on the same day.
