This is the execution record for the eighth slice of Epic 9 — letting the platform operator choose what
language an organization is onboarded in, and making every URL we hand to an owner (or to Stripe) land on a
page in that language.

# Phase 9 — Owner language and return paths

## Implementation Record

**Document version:** 1.0 — built 2026-08-02.
**Scope:** the missing language field on the provisioning form; the locale segment missing from every
server-built app URL; where the owner lands after paying and after using the customer portal; what can and
cannot be done about the language of Stripe's own hosted pages.
**Depends on:** [phase-9-saas-administration.md](phase-9-saas-administration.md) §4 for the provisioning
schema, [phase-9-subscription-and-activation.md](phase-9-subscription-and-activation.md) §3 for the payment
link, [phase-9-customer-portal.md](phase-9-customer-portal.md) §2 for the portal session, and
[phase-9-owner-onboarding-emails.md](phase-9-owner-onboarding-emails.md) for the five emails that surfaced
this.
**Exit criteria:** An English-speaking owner can be provisioned without editing the database · Every link we
build for them resolves to an English page · Stripe's customer portal opens in their language · The one
Stripe surface we cannot translate is documented rather than left as a mystery

---

# 1. What was actually wrong

The report was that all five onboarding emails arrived in Hungarian.

Nothing was wrong with `resolveLocale`. It reads `Tenant.defaultLanguage`, which is exactly right — the
organization's language is the correct default for mail to its owner, since there is no customer in the
loop to prefer. The problem was one level up: **`defaultLanguage` had never been a question anybody was
asked.**

`provisionOrganizationBodySchema` has carried `defaultLanguage: z.enum(["hu", "en"]).default("hu")` since
the slice that introduced it. The API accepted it. The platform form never sent it, so the default won every
time, and the only way to provision an English organization was to `PATCH` the row afterwards or to POST by
hand.

Two things followed from the same omission, and both were found while fixing it:

**The emails were in the right language and pointed at the wrong page.** Every URL built server-side is
`` `${appBaseUrl}/dashboard/subscription` ``, `` `${appBaseUrl}/invitations/${token}` `` and so on — with no
locale segment. `next-intl` is configured `localePrefix: "as-needed"` with `defaultLocale: "hu"`, so an
unprefixed path _is_ the Hungarian URL. An English owner's English email linked them to a Hungarian screen.

**Stripe sent them back to the same place.** `portalReturnUrl` was `` `${env.APP_BASE_URL}/dashboard/subscription` ``,
and the Payment Link had no `after_completion` at all — so paying ended on Stripe's own confirmation page
and the owner was never returned to the product they had just bought.

---

# 2. One place that knows how to build an app URL

`buildAppUrl` in `@bam/contracts` (`app-url.ts`). It takes a base URL, a path and a locale, and applies
next-intl's `as-needed` rule:

```ts
buildAppUrl({ baseUrl, path: "/dashboard/subscription", locale: "en" });
//   → "http://localhost:3000/en/dashboard/subscription"
buildAppUrl({ baseUrl, path: "/dashboard/subscription", locale: "hu" });
//   → "http://localhost:3000/dashboard/subscription"
```

**It lives in `@bam/contracts` and not in either app** because the API and the worker both build these URLs
and neither can see the other. `@bam/contracts` is the package both already treat as shared vocabulary, and
this is vocabulary: what a link to a screen looks like is a fact about the product, not about whichever
process happened to emit it. The worker gains `@bam/contracts` as a dependency to reach it.

**The `hu` case emits no prefix on purpose.** `/hu/dashboard/subscription` also works — next-intl's
middleware redirects it — but emitting the canonical form means the URL in an email is the URL in the
address bar, and one fewer redirect on a link somebody may open on a slow phone.

**An unrecognised locale falls back to the default rather than being interpolated.** A malformed language
column must not be able to produce `/de-DE junk/dashboard`; a wrong-language page is a defect, a broken URL
is a dead end.

---

# 3. The language field

`platform-screen.tsx` gains a select alongside the mode select, and sends `defaultLanguage` with the rest of
the form. That is the whole change on the API side — the schema already validated it.

**A select, not a free-text field**, matching `mode`: the schema is a two-value enum, and a text input would
turn a compile-time-closed set into a runtime 400 for anybody who typed `en-GB`.

**Defaulted to `hu` in the markup as well as in the schema**, so the visible default and the enforced default
cannot drift. The form now states what was previously implicit, which is the actual fix — the old behaviour
was not wrong, it was invisible.

`defaultTimezone` has the identical shape of problem and is deliberately left alone in this slice. It is not
a two-value enum, so a picker for it is a different piece of work, and unlike language it is not currently
producing a wrong-looking result for anybody.

---

# 4. Where the owner lands

## 4.1 After paying

`after_completion: { type: "redirect", redirect: { url } }` on the Payment Link, pointing at the
organization's own `/{locale}/dashboard/subscription`.

The URL is baked into the link at creation time, which is only sound because **a link now belongs to one
organization** ([phase-9-duplicate-subscription-prevention.md](phase-9-duplicate-subscription-prevention.md)
§4.1). Under the previous design — one permanent link per plan, shared by every customer — there would have
been no single correct destination to bake in, and this section could not exist.

A redirect rather than a customised `hosted_confirmation`, because the subscription screen already knows how
to render every state the owner can be in when they arrive, including _not activated yet_: activation is a
webhook, so a fast payer beats the event home. The screen polls; a static confirmation page would have to
lie or say nothing.

## 4.2 After the customer portal

`portalReturnUrl` becomes a base URL plus the tenant's locale, resolved per session rather than fixed at
composition time. `portalSession` already loads a row for this tenant, so the language comes back on the
same query — no second round trip to make a URL.

---

# 4.3 Whose language is a tenant's booking page in?

**Added 2026-08-11, after `/medicare/book` was found redirecting to `/en/medicare/book` during manual
testing.** Not a regression — this had been the behaviour since Phase 1, and nobody had looked at a customer
page with an English-configured browser before.

`defineRouting` never sets `localeDetection`, so next-intl's default applies: the middleware reads
`Accept-Language`, and redirects. Reproduced exactly:

```
Accept-Language: en-US  →  307  /en/medicare/book
Accept-Language: hu-HU  →  200  (stays)
```

**That is right for our screens and wrong for a tenant's.** The dashboard, sign-in and the platform console
are ours, and a person reading them should get their own language. A Hungarian clinic's booking page opening
in English because the visitor's laptop is set to English is not a localisation — the services are named in
Hungarian, the Epic 7 assistant answers in whatever the page says, and the clinic chose none of it.

So the rule is now: **on `/{tenantSlug}` and `/{tenantSlug}/book`, the tenant's `defaultLanguage` decides,
unless the visitor has said otherwise.** Everything else keeps browser detection.

Three parts, and each exists because the obvious one-part version does not work:

- **`proxy.ts` runs two middlewares** and picks by path (`isTenantPath` in `routing.ts`). Detection has to be
  off in the middleware, not merely overridden in the page: with it on, a page redirecting
  `/en/medicare/book` → `/medicare/book` is sent straight back by the middleware, forever.
- **`book/page.tsx` decides**, because it is the first place the tenant is known. Middleware cannot ask —
  it would need a per-request lookup on the edge to answer a question about which of two correct languages
  a page opens in.
- **`bam.locale` is the visitor's own choice**, written only by the locale switcher. next-intl's
  `NEXT_LOCALE` cannot serve: it is written as part of resolving *any* request, so after one page view every
  visitor has one and it says nothing about intent. Without a cookie of our own, the tenant's default would
  be reapplied over the top of the customer who had just used the switcher.

The booking page also gains that switcher. It had none — a customer who landed in the wrong language could
only edit the URL, which is not a thing to ask of somebody trying to book a haircut.

An unroutable `defaultLanguage` is ignored rather than interpolated, on the same reasoning as §2's note about
`resolveAppLocale`: a wrong-language page is a defect, a 404 is a dead end.

`routing.test.ts` pins the classification, including a check that reads `app/[locale]/` and asserts every
directory beside `[tenantSlug]` is treated as ours — because that list is hand-maintained and a route added
beside it would otherwise silently stop following the reader's language.

---

# 5. Stripe's own pages

## 5.1 The customer portal: fixed

`billingPortal.sessions.create` accepts `locale`, and `hu` is among the values it supports. It is now passed
from `Tenant.defaultLanguage`. Left unset, Stripe falls back to the customer's `preferred_locales` or the
browser — which is how an English page was reached from a Hungarian organization.

## 5.2 The payment page: not fixable, and why we are not going to try

**`paymentLinks.create` has no `locale` parameter.** Checked against the SDK types for the pinned API
version (`2026-07-29.dahlia`); only `checkout.sessions.create` has one. A Payment Link's hosted page detects
the buyer's browser language and there is no supported override.

Three options were considered:

| Option                                   | Verdict                                                                                                                                                                                                                                                                                   |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Leave it to browser detection            | **Chosen.** Correct for almost every real buyer, and zero surface area.                                                                                                                                                                                                                   |
| Append `?locale=xx` to the link URL      | Rejected. Undocumented, unsupported, and it would fail _silently_ — the page would simply be in the wrong language again, with a line of code claiming otherwise.                                                                                                                         |
| Replace the link with a Checkout Session | Rejected. It reverses [phase-9-subscription-and-activation.md](phase-9-subscription-and-activation.md) §7 for a cosmetic gain: a Checkout Session expires in 24 hours and the subscribe window is 14 days, so it would need an expiry-and-reissue path built to buy a translated heading. |

So the payment page follows the buyer's browser, and that is the documented behaviour rather than an
outstanding defect. Note that this is also _usually the better answer_: the link is explicitly forwardable to
whoever holds the company card, and that person's browser is better evidence of what they read than the
organization's configured default.

## 5.3 Not a locale problem: the statement descriptor

Stripe's confirmation reads:

> After your trial, a payment to **Stripe** will appear on your statement.

That is the Stripe account's statement descriptor being unset, not a translation fault, and it will appear on
real owners' bank statements exactly as written. It is a dashboard setting
(**Settings → Business → Public details**) with no code component, and it is recorded here because the
symptom arrived alongside the language one and reads like part of it.

---

# 6. Verification

- Unit: `app-url.test.ts` covers the prefix rule in both directions and the unrecognised-locale fallback.
- Unit: `billing.test.ts` asserts the portal session is created with the tenant's locale and a locale-correct
  `return_url`, and that the payment link is created with an `after_completion` redirect to the same.
- Manual: [phase-9-manual-test-checklist.md](phase-9-manual-test-checklist.md) gains an English-organization
  pass — provision with `en`, confirm all five emails and every link in them are English.
