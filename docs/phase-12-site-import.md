# Phase 12 — Import from the organization's website

## Implementation Record

**Document version:** 1.0 — planned and built 2026-10-05.
**Scope:** draft the default-language company profile, services and FAQs from the website at `tenants.domain`; nothing is written by the import.
**Depends on:** [Phase 12](phase-12-assistant-knowledge-consistency.md) §2.1 (records beat prose), §7.4 (metered model calls), and [service translation drafts](phase-12-service-translation-drafts.md).
**Status:** built. **Not run against the real model or a real website yet** — §7 says what that
leaves unproven. §1–§5 below are the plan as approved; §6 records where the build differs from it.

## Context

The owner has already written everything on their own website: who they are, what they offer, prices,
and frequently asked questions. Today they retype it into three editors: the company profile on
Overview, the service catalogue, and the FAQs. Phase 12 already drafts _translations_ of those texts.
This is the step before that: draft the **default-language** originals (Hungarian, typically) from the
website. The owner reviews them and saves through the ordinary editors. Nothing is written by the
import itself.

Decisions already taken with the user:

- **The registered domain only.** The importer reads `tenants.domain` (set at provisioning, normalised
  by `normalizeDomain`) and its subdomains. There is no free URL field. That proves the site is theirs
  and keeps the API from becoming a general URL fetcher.
- **Services are a draft list, added one by one.** Each "Add" opens the ordinary create form,
  pre-filled. The owner confirms the duration (a website rarely states one) and saves. Nothing becomes
  bookable without them.

Constraints that shape it:

- **Phase-12 §2.1 / K1–K8 (records beat prose).** The generated profile must not restate hours,
  prices, addresses, contact details or a service list. Those have structured homes, and the knowledge
  check would flag them at once. Prices and descriptions go on the proposed services instead.
- **Paid model call.** It goes through `KnowledgeAiService.metered` (reserve → call → reconcile, the
  chat's monthly allowance), behind the same `manage` guard (`ASSISTANT_MANAGE` + plan entitlement).
- **SSRF.** The API runs beside Postgres and Redis on a Hetzner VPS (phase-10 §2.9). A domain can
  resolve to a private address, so every fetch has its address checked at connect time.

## Step 0 — record

Write `docs/phase-12-site-import.md` (version, scope, **Depends on:**, "plan") holding this plan. Link
it from `docs/phase-12-assistant-knowledge-consistency.md` and from the phase-records line in
`CLAUDE.md`. Convert it to a record when done.

## 1. Fetching — `apps/api/src/modules/assistant/site-reader.ts` (new)

I/O stays in the API. The pure parts are exported separately so they can be unit-tested.

- **`isPublicAddress(ip)`** uses Node's built-in `net.BlockList`, so no dependency. It rejects:
  - IPv4: loopback, `0/8`, `10/8`, `172.16/12`, `192.168/16`, `169.254/16` (cloud metadata),
    `100.64/10`, multicast and reserved ranges;
  - IPv6: `::1`, `fc00::/7`, `fe80::/10`, and IPv4-mapped addresses (checked as their IPv4 form).
- **`fetchPage(url)`** uses `node:http(s).request` with a custom `lookup` that resolves and then
  validates every address, so the check runs on the socket's own resolution: no TOCTOU, no DNS
  rebinding.
  - **Scheme and ports:** `http` and `https` only, ports 80 and 443 only.
  - **Redirects:** at most 3, each re-validated, and each must stay on the site (below).
  - **Limits:** 10 s timeout, 2 MB body cap, `text/html` only.
  - **User-Agent:** `BookingAndMoreImporter/1.0`.
- **`onSite(host, domain)`:** `host === domain` or `host.endsWith("." + domain)`.
- **`readSite(domain, fetchPage)`** does the crawl:
  - start at `https://{domain}/`, falling back to `http://`;
  - honour `robots.txt` `Disallow` for `User-agent: *`;
  - follow same-site links ranked by path keywords (`szolgaltatas`, `arak`, `araink`, `gyik`,
    `rolunk`, `kapcsolat`, `services`, `prices`, `faq`, `about`, `contact`, …);
  - read at most **12 pages**.
- **`htmlToText(html)`** is pure, using `node-html-parser` (a new dependency of `apps/api`; §6 corrects
  what the plan said about its dependencies).
  - Drop `script`, `style`, `noscript`, `svg`, `iframe` and forms.
  - Keep headings as `#` and list items as `-`.
  - Lines repeated on most pages (header, footer, cookie banner) are removed by `dedupeBoilerplate`.
  - The total is capped at about 60k characters, so the input token count stays bounded.
- **Injectable.** `buildApp` takes an optional `siteFetcher` option (the same pattern as
  `knowledgeAssistant`), so tests never touch the network.

## 2. Model call — `packages/ai/src/knowledge.ts`

- Add `importFromSite(input, maxOutputTokens)` and `countImportTokens(input)` to the
  `KnowledgeAssistant` interface. Implement both on the Anthropic class and on
  `FakeKnowledgeAssistant`, which is scripted with `nextImport`.
- **`buildImportPrompt({ language, pages })`:**
  - each page goes in a fenced `<page url="…">` block, cleaned by the existing `clean`/`attribute`
    helpers, so tenant text cannot close a block;
  - output is in the tenant's default language;
  - only facts present on the pages;
  - the profile follows K1–K8: no hours, prices, addresses, contact details, named testimonials or a
    list of treatments, because those belong in records;
  - FAQs come from FAQ-like content, or from clear statements on the site (payment, parking, first
    visit), never invented.
- **Forced tool `report_import`:**
  - `profile`: string;
  - `services[]`: `{ name, description, priceMinor|null, currency|null, durationMinutes|null,
sourceUrl }`;
  - `faqs[]`: `{ question, answer, sourceUrl }`.

  It is parsed again by a `parseImport` guard. A `max_tokens` stop is a failure, as in part 4.

## 3. Service and route

`KnowledgeAiService.siteImportDraft(tenantId)` lives in
`apps/api/src/modules/assistant/knowledge-ai.service.ts` and reuses `metered()`.

- **Refusals:**
  - no `tenant.domain` → `ValidationError`, `field: "domain"`;
  - no readable page → a new `SITE_UNREACHABLE` code in `@bam/contracts`, whose `details.reason` is
    one of `blocked_address`, `not_html`, `timeout` or `http_status`.
- **Read and call:** read the site, then make the metered call with max output about 8k tokens.
- **Verify, as the audit's verbatim-excerpt check does:**
  - drop any service whose name does not occur in the crawled text, ignoring case and whitespace;
  - drop any `sourceUrl` that was not crawled;
  - report the dropped count as `discarded`.
- **Mark duplicates:** a proposed service whose normalised name equals an existing non-archived
  service's name gets `existingServiceId`.
- **Cache** in memory by a hash of the crawled text, the same way as `audits`, so pressing twice on an
  unchanged site costs one call.
- **Route:** `POST /v1/assistant/knowledge/site-import` in `assistant.routes.ts`, with an empty-body
  schema and a response schema `siteImportDraftSchema` in `packages/contracts/src/knowledge.ts`.
  - Guard: `manage`, plus a route rate limit (for example 5 per hour per tenant), because each press
    crawls up to 12 pages.
  - Audit `assistant.knowledge.site_imported` with `{ domain, pages, services, faqs }` and no content
    (rule 6).

## 4. Web — `apps/web/src/components/business-knowledge.tsx`

A block **"Import from {domain}"**, shown to `canManage` when the tenant has a domain. If `MeResponse`
does not carry `tenant.domain`, add it. It shows the pages read, the discarded count and a "nothing is
saved until you do" note. Errors go through `aiErrorKey` plus a `SITE_UNREACHABLE` message.

- **Profile.** "Use as {language} profile" fills the default-language textarea through `fill`
  (`lib/fill-field.ts`), with the draft marker, and asks before overwriting (`useConfirm`). It is saved
  with the existing profile Save.
- **FAQs.** An Add/Discard list in the default locale, reusing the FAQ-draft list markup and the
  existing `POST /v1/assistant/faqs` mutation.
- **Services** (only with `service:manage`):
  - each proposal has Add, which expands an inline form built from `ServiceFields` with
    `serviceStateFrom()` overridden by the proposal (name, description, price, currency);
  - **the duration is blank and required** when the site gave none, so the owner has to decide;
  - the form posts `/v1/services` exactly as `CreateServicePanel` does;
  - proposals with `existingServiceId` show "already in your catalogue" and Discard only.
- **Messages:** new keys in `businessKnowledge.import.*`, in `en.json` and `hu.json`.
- **Budget.** The knowledge budget is still enforced by each save path (`withKnowledgeBudget`), so an
  oversized import cannot slip past it.

## 5. Not in scope (listed in the record)

- Locations, working hours and contact details from the site. These have structured homes, and the
  knowledge check would flag them anyway.
- Translations: drafted afterwards with the existing buttons.
- Re-import diffing.
- JavaScript-rendered sites. A page with no server-rendered text is reported as such, not guessed.

## Verification

- **Unit tests** in `apps/api/src/modules/assistant/site-reader.test.ts`:
  - `isPublicAddress` rejects 127.0.0.1, 10.0.0.1, 169.254.169.254, 100.64.0.1, ::1, fd00::1 and
    ::ffff:127.0.0.1, and accepts a public address;
  - `onSite` refuses `evilwellness.hu` for `wellness.hu`;
  - `htmlToText` keeps headings and lists and drops scripts;
  - `dedupeBoilerplate` removes repeated lines;
  - robots `Disallow` is honoured;
  - the redirect limit holds.
- **`@bam/ai` tests:** the prompt fences pages and resists forged `</page>`; `parseImport` drops
  malformed entries.
- **API integration** (`knowledge-ai.test.ts`, with a fake `siteFetcher` and `FakeKnowledgeAssistant`):
  - a draft writes no service, FAQ or settings row;
  - an invented service name is discarded and counted;
  - an existing service is marked;
  - no domain → 422;
  - an unreachable site → `SITE_UNREACHABLE` and no model call;
  - quota refusal happens before the call;
  - a STARTER plan → 403;
  - the cache hit costs nothing.
- **E2E** (`apps/web/e2e/knowledge-health.spec.ts`, mocked API, both locales):
  - the profile fills and is marked;
  - FAQ Add posts the default locale;
  - service Add pre-fills the create form with the duration required, and saves only on submit;
  - plus a screenshot.
- **Full checks:** `pnpm lint && pnpm check-types && pnpm test`; the web build with
  `NEXT_PUBLIC_API_BASE_URL=https://api.example.test`, then `pnpm test:e2e`.
- **Manual:** run against the `wellness` tenant's real domain on staging with the real model,
  stating in the record that it was done. Until then the record says it has not been run, as the rest
  of phase 12 does.

## 6. As built — where it differs from the plan

- **`node-html-parser` is not dependency-free.** It brings `css-select` and `he`. They are small,
  widely used and only parse; this was accepted rather than writing an HTML parser by regex.
- **The fetcher returns any text response, and the crawler decides what is HTML.** The first draft
  special-cased `robots.txt` by comparing function identity. Instead, `SiteFetcher` returns
  `{ url, contentType, body }`, the body is read only for `text/html`, `application/xhtml` or
  `text/plain`, and `readSite` refuses a page that is not HTML (`not_html`). `robots.txt` goes through
  the same checked fetcher, so it cannot sidestep the address or redirect checks.
- **IP literals are refused before connecting.** A host that is an IP literal never reaches the socket's
  `lookup`, so `fetchSitePage` checks it explicitly. `onSite` would refuse it anyway, since a domain is
  never an address.
- **Failures:** `SITE_UNREACHABLE` is a 422 carrying `details.reason`. The reasons are
  `blocked_address`, `off_site`, `not_html`, `timeout`, `http_status`, `unreachable` and `no_text`.
  The screen maps them to three messages:
  - unreachable;
  - an address we do not connect to;
  - no readable text, meaning a site rendered in the browser.

  A home page on a refused address is not retried on another scheme.

- **Limits:**
  - 8 s per page, 40 s for the whole crawl, 12 pages, batches of 4;
  - 2 MB per body (the first 2 MB are kept rather than failing);
  - 60 000 characters of text in all;
  - 8 192 output tokens;
  - route rate limit 10 per hour.
- **Charset:** `iso-8859-2` and other charsets are decoded from the `Content-Type` header or a
  `<meta charset>`, because older Hungarian sites still use them.
- **Verification after the model call:**
  - a proposed service is kept only if its name occurs in the text read (case- and
    whitespace-insensitive; accents count) and its `sourceUrl` is a page that was read;
  - a FAQ is kept only if its `sourceUrl` was read;
  - duplicates within the draft are dropped;
  - `discarded` counts all of these.

  `parseImport` in `@bam/ai` drops a price without a valid currency, and a duration outside 5–720
  minutes (rule 15).

- **Prices travel in major units.** The draft carries `price` as written on the site (12 000 Ft is
  `12000`), which is what the create form's price field takes. The form converts with
  `toMinorUnits`, as it does for typed prices. The browser's currency data gives HUF no minor unit, so
  `12000` is what is stored, exactly as for a hand-typed price.
- **The create form was extracted, not duplicated.** `CreateServiceForm`
  (`components/create-service-form.tsx`) is what `CreateServicePanel` on the Services screen now
  renders, and what a service proposal expands into. It accepts `initial` and `onCreated`.
- **`/v1/me` carries `tenant.domain`.** It is read separately in `me.routes.ts`, because
  `ResolvedTenant` carries only what every request needs.
- **Audit:** `assistant.knowledge.site_imported` with `{ domain, pages, services, faqs }`. A cached
  answer writes no audit entry, as a cached audit does not, because it spends nothing.
- **The profile marker** reads "Drafted from {domain}". It is a separate flag from the translation
  marker, because only the default-language profile is ever imported.

## 7. Verified, and not

- `site-reader.test.ts`, 29 tests:
  - private, loopback, metadata, CGNAT, ULA, link-local and IPv4-mapped addresses are refused;
  - lookalike domains are refused;
  - the real fetcher refuses `127.0.0.1` and `localhost` (which resolves privately) before
    connecting, and refuses a foreign host, a non-default port, `ftp:` and credentials;
  - HTML to text, boilerplate removal, link extraction and ranking, robots rules;
  - a crawl that honours robots and the page limit, and the three failure reasons.
- `@bam/ai`: the import prompt fences pages and resists a forged `</page>`; `parseImport`.
- API `knowledge-ai.test.ts`, against the test database:
  - no domain → 422 and no model call;
  - unreachable → `SITE_UNREACHABLE` and no model call;
  - an invented service and an off-site FAQ are discarded and counted;
  - an existing service is marked;
  - the off-site link is never fetched;
  - the model receives text, not markup;
  - no service, FAQ or profile row is written;
  - tokens are metered, and a cache hit spends nothing.
- Web e2e, in both locales:
  - the profile fills, asking first, and carries its marker;
  - an existing service shows as such;
  - Add opens the create form with the duration blank;
  - submitting without a duration sends nothing;
  - with one, it creates the service with the site's price;
  - a FAQ is added in the default language;
  - the profile is not saved by the import.

  Repo-wide lint, typecheck and tests pass, and all 86 e2e tests pass.

- **Not proven:**
  - **Redirect handling of the real fetcher.** A test server would sit on a loopback address, which
    the fetcher refuses by design, so following redirects (≤ 3, each re-checked) is covered only by
    reading the code.
  - **The prompt on the real model.** Whether it keeps hours and prices out of the profile, and
    whether the knowledge check stays quiet afterwards, can only be seen by running it.
  - **A real website.** None has been read.

  **The first step is to run the import against the `wellness` tenant's real domain on staging, then
  run the knowledge check on what was added.**
