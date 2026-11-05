# Customer onboarding and website links

Decided 2026-11-01. Follows [the public site record](public-site-and-legal-pages.md).
A review of the path a new customer takes, from the first email to booking buttons
on their own website, using the wellness demo
([`demo/wellness`](../demo/wellness), deployed at `wellness-demo.appointer.hu`) as
the picture of the end result.

**Status: built.** Verified against a local production build: 86 browser tests,
including `website-links.spec.ts` and the rewritten home-page test in
`staff-pwa.spec.ts`. Not yet seen on staging; that needs a redeploy with a rebuild,
for the web app and the worker, which renders the email.

## 1. The path, and what was wrong with it

| Step                               | What the customer gets                 | Where it lands                                        |
| ---------------------------------- | -------------------------------------- | ----------------------------------------------------- |
| 0. First contact (written by hand) | `booking.appointer.hu`                 | The home page                                         |
| 1. Provisioning in `/platform`     | `ORGANIZATION_CREATED`: the invitation | `/invitations/<token>`: accept and register           |
| 2. Pending dashboard               | `SUBSCRIPTION_LINK`: the Stripe link   | Stripe's payment page                                 |
| 3. The webhook activates           | `SUBSCRIPTION_CONFIRMED`               | `/dashboard`                                          |
| 4. Dashboard                       | —                                      | The booking QR codes, and the chat QR on Professional |

Four defects:

1. **The home page addressed people who already had an account.** It led with
   "Open staff workspace", "Create an owner account" and a phone-app install section;
   the prices were at the bottom. Step 0 sends a prospect there before any of that
   applies.
2. **"Create an owner account" contradicted the launch.** The cohort is
   `LAUNCH_ACCESS_MODE=invite_only`: an address not in
   `LAUNCH_OWNER_EMAIL_ALLOWLIST` can register but is refused when it creates an
   organization or starts checkout. A public link to a dead end is worse than none.
   The sign-in page carried the same link.
3. **After subscribing, nothing gave the owner the website links.** The goal of
   onboarding is the wellness demo's shape: a "Foglaljon időpontot" / "Book an
   appointment" button in the page body and a "Munkatársaknak" / "For staff" link in
   the header. The dashboard showed only QR images; the booking URL, the staff sign-in
   URL (`/{domain}/sign-in`, which the demo uses) and the staff-app install page were
   nowhere to copy. The confirmation email said to add providers and services, and
   nothing about the website.
4. **The demo was linked from nowhere.**

## 2. Decisions

### 2.1 The home page is for prospects

What the product does; a link to the wellness demo; the three steps to start
(contact us, accept the invitation and subscribe, add booking to your website); the
plans with their "Contact us" buttons; the footer. Staff keep "Sign in" in the
header. The install instructions are not lost: every tenant has
`/{slug}/install/staff`, now linked from the dashboard, and the dashboard header
keeps its own install button.

The demo address is a constant (`DEMO_SITE_URL` in `lib/demo-site.ts`), like the
hosting provider: it is ours and public, and not personal.

### 2.2 The dashboard has a "Put booking on your website" section

Shown once the organization is subscribed (`!awaitingSubscription`), in place of the
bare QR section:

- **Links to copy:** booking (Hungarian and English), chat when the plan includes it,
  staff sign-in, and the staff-app install page.
- **Two HTML snippets to copy:** the booking button for the page body and the staff
  link for the header, each in the organization's default language.
- **The QR codes**, unchanged, below them.

The staff sign-in link uses the organization's domain when one is set
(`/{domain}/sign-in`, as in the demo) and its slug otherwise; both routes resolve.
Links are built from `window.location.origin`, since the dashboard is served on the
app's own host, so staging hands out staging links and production production ones.
The snippets carry inline styles only, because they are pasted into somebody else's
page, whose stylesheet we do not know.

### 2.3 The confirmation email points at it

`SUBSCRIPTION_CONFIRMED` gains one line naming that section, after "everything is
unlocked". The dashboard link it already carries is the way there.

### 2.4 Sign-up stays, unlinked

`/sign-up` still exists: the operator registers through it before
`db:grant-platform-admin`, and an allow-listed owner may use the self-service path if
handed the address directly. No public page links to it. The sign-in page's
"Create an account" becomes a sentence saying accounts come from an invitation, with
a link to pricing for anyone who has none. Reopening public signup is the separate
decision the [launch runbook](production-launch.md) already requires.

**Recommended cohort path:** provisioning in `/platform` (step 1), the path whose
emails are described above. **It still needs an allow-list entry**, correcting what this
section first said: `POST /v1/billing/subscribe` calls `assertLaunchAccess`, so in
`invite_only` a provisioned owner whose address is not in
`LAUNCH_OWNER_EMAIL_ALLOWLIST` can accept the invitation and is then refused the
payment link. Add each approved owner's address, then restart the API. Accepting the
invitation already marks the address verified, so no further step is needed.

## 3. Found on the way

- The deployed `wellness-demo.appointer.hu` predates `ff824ea`: its links point at
  `app.booking.appointer.hu`, which answers 503 until production exists. The
  repository's copy points at `staging-app…`. **Redeploy the demo resource.** When
  production exists, switch the demo to it, or keep it on staging deliberately so
  that a demo booking never reaches a production tenant.
