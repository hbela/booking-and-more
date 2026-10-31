# Public site and legal pages

Decided 2026-10-31. Closes the `booking.appointer.hu` items in
[tasklist §2](production-deployment-tasklist.md): before the first live charge, the
website registered with Stripe must show the plans and prices, contact details, and
terms, privacy and cancellation/refund pages.

**Status: built, texts awaiting review.** The pages, footer, links and redirect are
in the tree. The legal texts are drafts written from what the code and the
operator's records say; they are a launch gate until an accountant or lawyer has read
them (§5).

## 1. Decision

The pages live in `apps/web`, and `booking.appointer.hu` redirects to
`app.booking.appointer.hu`. Rejected:

- **The portfolio** (`portfolio.appointer.hu`, the my-blog repo). It already renders
  terms and privacy for Finance Manager and Taskmanager, but it is the operator's
  personal portfolio. Stripe and the card networks check that the registered website
  presents the business and what it sells.
- **A separate site.** A fourth deployment to monitor, with prices typed twice.

The deciding reason: **the app needs these pages anyway.** An owner accepts the terms
when registering, and the public booking page collects patients' names, emails and
phone numbers, so it must link to a privacy notice. Pages on another site would make
every one of those links depend on that site.

## 2. What is built

| Path       | Content                                                                                                                                     |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `/pricing` | The three plans, from `SUBSCRIPTION_OFFERS` in `@bam/contracts`, the same source as the subscription screen; the trial; AAM; assisted setup |
| `/terms`   | Általános Szerződési Feltételek / Terms of Service                                                                                          |
| `/privacy` | Adatkezelési tájékoztató / Privacy notice                                                                                                   |
| `/refund`  | Lemondás és visszatérítés / Cancellation and refunds                                                                                        |

Hungarian at the unprefixed path, English under `/en`, as everywhere else.

- **A public footer** on the home page and these four pages: their links, and the
  _impresszum_ (seller name, address, tax number, registration number, EU VAT number,
  email, hosting provider). Hungarian e-commerce law (Ekertv. 4. §) requires it.
- **The home page** gains a pricing section and the footer.
- **Sign-up** states that creating an account accepts the terms and acknowledges the
  privacy notice, with both linked.
- **The booking flow's contact step** links the privacy notice's patient section.
- **`RESERVED_SLUGS`** gains `pricing`, `terms`, `privacy`, `refund`, `legal`,
  `invitations`, `sign-in` and `sign-up`, and `APP_SEGMENTS` the first four. A tenant
  slug shadowed by a static route would have a booking page nobody can reach.

### 2.1 The seller's details are configuration, not code

`LEGAL_NAME`, `LEGAL_ADDRESS`, `LEGAL_TAX_NUMBER`, `LEGAL_EU_VAT_NUMBER`,
`LEGAL_REGISTRATION_NUMBER` and `LEGAL_EMAIL` are runtime variables of the web
service. A sole trader's registered address is their own, and personal identifiers
stay out of the repo. They are read on the server at request time, not compiled in,
so changing one needs a restart rather than a rebuild. A field left unset is omitted
from the page; the launch gate is that all are set in production.

The hosting provider (Hetzner Online GmbH) is a constant, because it is not personal.

### 2.2 The redirect

`CANONICAL_REDIRECT_HOSTS` (comma-separated, runtime) names hosts the proxy answers
with a `308` to the same path on `APP_BASE_URL`. Opt-in by name, so a host nobody
listed is never redirected, and `/api/*` is outside the proxy's matcher, so health
checks are untouched.

Why not serve the app on both names: the API's CORS allow-list and Better Auth's
trusted origins accept only `APP_BASE_URL`, and session cookies are host-bound, so
signing in on the second name would fail.

## 3. Facts the texts rely on

Every claim in the texts comes from the code or the operator's records, so a change
to one of these must update the texts:

- Plans and amounts: `SUBSCRIPTION_OFFERS`. AAM: subject exemption, no VAT
  (tasklist §2). Trial: `TRIAL_PERIOD_DAYS` (30), once per organization, card taken
  up front.
- Billing: Stripe Payment Link per organization; monthly in advance; invoices by
  Billingo, reported to NAV. Card details reach Stripe only.
- Changes: Customer Portal `bpc_1UVBKKL8y0mQzxRgdCpH7HtL`. Upgrades immediate and
  prorated; downgrades and cancellation at period end; invoice history.
- Failed payment: `past_due` keeps access while Stripe retries (phase-9 subscription
  lifecycle §3).
- Retention: chat transcripts redacted after 90 days; backups encrypted with restic,
  kept 7 days in full plus 30 dailies; invoices 8 years (Számv. tv. 169. §).
- Customer PII is encrypted at rest with tenant-scoped blind indexes.
- Processors: Hetzner (hosting, DE), Cloudflare (encrypted backups), Stripe
  (payments), Billingo (invoices, HU), Resend (email, US), Sentry (errors, EU region),
  Anthropic (the AI chat, US, Professional plans only).

## 4. Deployment

1. Set the six `LEGAL_*` variables on the web service.
2. **DNS:** add an A record `booking` under `appointer.hu` to the VPS. The wildcard
   `*.booking.appointer.hu` does not cover `booking.appointer.hu` itself.
3. **Coolify:** add `https://booking.appointer.hu` to the production web service's
   domains, and set `CANONICAL_REDIRECT_HOSTS=booking.appointer.hu`.
4. Check: `curl -sI https://booking.appointer.hu/en/pricing` answers `308` with
   `location: https://app.booking.appointer.hu/en/pricing`.

Production does not exist yet. Until it does, the name can point at staging with the
same two settings, so Stripe's registered website answers; staging then redirects to
`staging-app…`, whose pages are the same.

## 5. Open

- **Review of the three texts** by an accountant or lawyer, and the operator's
  approval of every promise in them, in particular the refund cases in `/refund` §3
  and the liability limit in `/terms`.
- **A data-processing agreement** (_adatfeldolgozási megállapodás_, GDPR Art. 28)
  for clinics. `/terms` incorporates processing terms by reference to `/privacy` §4;
  a clinic may want a signed document.
- The effective date in each text is set when the reviewed version is published.
