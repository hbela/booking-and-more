This is the plan for a problem reported on 2026-10-05 against the `wellness` tenant: the AI receptionist
gives answers that are not always consistent, and the business knowledge it reads contradicts the
app's own records. The chat is the product's main selling point, so an assistant that offers
treatments nobody can book is a defect in the product, not a content problem of one customer.

# Phase 12 — Assistant knowledge consistency

## Implementation Record

**Document version:** 1.0 — planned and built 2026-10-05. **All five parts are built** (§7.1–§7.5).
Open items:
- §6's evaluation has **not been run** against the real model, and nothing in this phase has been;
- §5.3's email to a live tenant is not built.

§7.6 lists both.
**Scope:** (1) a written rule for which source is authoritative for each kind of fact the assistant
states; (2) a verification mechanism that finds where the company profile, service descriptions and
FAQs contradict the structured records, and shows it to the owner; (3) runtime changes so the
assistant follows the rule even when the text has not been fixed; (4) a repeatable evaluation that
makes "consistent" measurable.
**Depends on:** [multi-tenant-ai-receptionist-implementation.md](multi-tenant-ai-receptionist-implementation.md)
(the receptionist, `knowledgeContext`, the prompt fence) ·
[phase-3-4-schedule-conflicts.md](phase-3-4-schedule-conflicts.md) (the "warn once, re-send
acknowledged" pattern reused in §5.4) ·
[phase-2-3-owner-management.md](phase-2-3-owner-management.md) §2.6 (who decides what: the owner
configures the catalogue, availability belongs to the provider).

**Note on CLAUDE.md:** its withdrawal paragraph said chat was withdrawn and that no `@bam/ai` existed.
Both stopped being true with the receptionist on 2026-08-20. It was corrected in part 5.

---

# 1. What was found

## 1.1 The `wellness` tenant, local database, 2026-10-05

| Fact | Structured record (what the app will actually do) | Company profile (HU only, 3,154 chars) | Severity |
| --- | --- | --- | --- |
| Bookable services | **Konzultáció** only (30 min, no price) | "Szolgáltatásaink": általános fogászat, szájsebészet, fogszabályozás, esztétikai fogászat, fogtechnika | Error |
| Providers | **Dr Kiss Katalin**, **Hauser Max** | Dr. Kocsis Zoltán (leader), "Kiss Éva doktornő" (in a review) | Error |
| Location | **Szentendre**, Szirt utca 11 | "Wellness Fogászat **Budapest**", "budapesti lakosokat"; a review says Szentendre | Error |
| Hours | Dr Kiss Katalin Mon–Fri **09:00–17:00**; Hauser Max has **no** working hours | "hétfőtől péntekig **8 és 20** óra között" | Error |
| Price | `price_minor` **null** | Start csomag 31.000 Ft — stated in the profile **and** again in the service description | Warning |
| Contact | `contact_email`, `contact_phone`, both policies **null** | "Kérjen időpontot…" with no way to do so | Warning |
| Languages | No EN/DE/FR profile, no service translations, **no FAQs at all** | — | Warning |
| Personal data | — | Five testimonials with customers' full names | Warning |

Every row is a question a patient will plausibly ask, and in every row the model is handed two
answers and asked to pick.

## 1.2 Why the answers vary, not just why they are wrong

1. **Everything is one undifferentiated block.** `AssistantService.knowledgeContext` concatenates the
   profile, locations, contacts, policies, services and FAQs into `<business-facts>`. Nothing tells the
   model that `Service:` lines are the bookable set and the profile's bullet list is marketing copy.
   The only precedence rule that exists is for providers (`prompt.ts`, added after the same class of
   bug with doctors' names); services, locations, hours, prices and contacts have none.
2. **The structured facts the model needs are not in the block.** Service duration and price,
   working hours, and which providers offer which service are never sent. Asked "when are you open?",
   the model can only quote the profile's 8–20, because the 09:00–17:00 it contradicts is not there.
3. **Language fallback is asymmetric.** `localizedBusinessDescription` falls back to the default
   language's profile, but FAQs are filtered by exact `locale` with no fallback. An English customer
   gets the Hungarian profile and zero FAQs; the model translates on the fly, differently each time.
4. **Answers that could come from records are written by the model.** The same call is both the
   intent classifier and the author of every `ANSWER_FAQ` text, and sampling cannot be pinned on
   this model (§4.4). "What do you offer?" is answered in prose from the profile rather than by
   `LIST_SERVICES` from the database, so it can be worded and listed differently on two attempts.
5. **Inconsistency is created by changes elsewhere, not only by editing the text.** Archiving a
   provider, renaming a service or changing hours makes a correct profile wrong without anyone
   touching it. A check that runs only when the profile is saved will miss most of these.

---

# 2. The rule: one source of truth per kind of fact

## 2.1 Precedence

The assistant states a fact **only from its authoritative source**. Free text may describe and
explain; it may never be the only source for a fact that has a structured home, and where they
disagree the structured record wins.

| Kind of fact | Authoritative source | What free text may add |
| --- | --- | --- |
| What can be booked | Active, non-archived services (+ translations) | What a service involves, who it suits |
| Duration and price | The service's `durationMinutes`, `priceMinor`, `currency` | Package explanations that agree with the price |
| Who works here | Active providers offering an active service | Credentials, focus — of those providers only |
| Where | Active locations | Directions, parking, access |
| When | Working hours (bookable times), per location | Nothing that contradicts them |
| How to reach us | `contactEmail`, `contactPhone` | — |
| Booking / cancellation rules | `bookingPolicy`, `cancellationPolicy` | — |
| Everything else (history, equipment, philosophy, payment methods) | Profile and FAQs | This is what they are for |

## 2.2 Owner-facing authoring rules

These go into the dashboard as help text beside the profile editor, in both locales, and are what
the verifier in §3 checks.

- **K1 — Offerings.** Do not list a treatment as offered unless it is a bookable service, or say
  explicitly how it is reached ("A fogszabályozás a konzultáción tervezhető meg"). The assistant will
  otherwise offer to book something it cannot book.
- **K2 — People.** Name only people who are providers here. A non-treating leader or a lab partner
  may be named with their role, and is then recorded as such (§3.3).
- **K3 — Place.** City and address come from Locations. Do not restate them in prose; if you must,
  they have to match.
- **K4 — Hours.** Do not state opening hours in prose. The assistant reads them from working hours.
- **K5 — Prices.** A price belongs on the service. A price that appears only in text is a warning;
  one that disagrees with the service is an error.
- **K6 — One fact, one place.** Something specific to a service (the Start csomag) belongs in that
  service's description, not also in the profile.
- **K7 — Languages.** Every language the assistant is enabled for has a profile and its FAQs in that
  language, or deliberately falls back to the default language (§4.3) — never half of each.
- **K8 — No third parties' personal data.** No testimonials with customers' names. CLAUDE.md rule 6
  applies to what we send to a model as much as to what we log.

---

# 3. Verification mechanism

Three layers, cheapest first. Each produces the same `KnowledgeFinding` shape, so the dashboard shows
one list.

```ts
// @bam/contracts
interface KnowledgeFinding {
  code: KnowledgeFindingCode;        // e.g. "UNBOOKABLE_SERVICE_MENTIONED"
  severity: "ERROR" | "WARNING";
  rule: "K1" | … | "K8";
  source: { kind: "PROFILE" | "SERVICE" | "FAQ"; id?: string; locale: Language };
  excerpt: string;                   // the offending text, ≤ 200 chars
  expected?: string;                 // what the structured record says
  origin: "DETERMINISTIC" | "MODEL";
}
```

## 3.1 Layer 1 — deterministic checks (pure, every read)

A new pure package, `@bam/knowledge-engine`, following rule 8: no Prisma, no Fastify, no model. Input
is a snapshot (services, translations, providers, locations, working hours, contact fields, profile
texts, FAQs); output is `KnowledgeFinding[]`. Property-testable like the availability engine.

| Code | Rule | Detection |
| --- | --- | --- |
| `PERSON_NOT_A_PROVIDER` | K2 | Title-prefixed names (`Dr.`, `dr.`, `doktornő`, `Prof.`) and capitalised name pairs, compared to provider names with diacritic folding and edit distance — "Kiss Éva" vs "Kiss Katalin" is reported as a *probable typo*, not just as unknown |
| `CITY_MISMATCH` | K3 | Hungarian and international city gazetteer (inflected: *budapesti*, *Budapesten*, *Szentendrén*) vs location cities |
| `HOURS_STATED` / `HOURS_MISMATCH` | K4 | `H–H óra`, `8:00–20:00`, weekday ranges; mismatch if not equal to the union of working hours |
| `PRICE_NOT_RECORDED` | K5 | `31.000 Ft`, `31 000 HUF`, `€40` vs every bookable service's `priceMinor` (amended in §7.2) |
| `CONTACT_MISSING` | — | Profile invites contact; `contactEmail` and `contactPhone` both null |
| `UNBOOKABLE_SERVICE_MENTIONED` | K1 | Bullet items under a heading matching *Szolgáltatás*, *Services*, *Leistungen*, *Prestations* that match no service name (folded, stemmed) |
| `DUPLICATED_FACT` | K6 | Same price token or ≥ 80-char shingle in profile and a service description |
| `LOCALE_MISSING` | K7 | Supported locale with no profile, or with services but no translations, or FAQs in one locale only |
| `PERSONAL_DATA` | K8 | Quoted text followed by `– Firstname Lastname` |
| `PROVIDER_WITHOUT_HOURS` | — | Active provider with no working hours (Hauser Max) — not a text problem, but it is the reason a "who can I book" answer and the booking page disagree |

Runs on every `GET /v1/assistant/knowledge/health`. It is cheap, so it is never cached — which is
what catches §1.2.5: the profile did not change, the providers did.

**Known limit, stated so nobody over-trusts it:** layer 1 cannot read prose. It will find "Budapest"
next to a Szentendre location; it will not notice that "a környék legfelszereltebb rendelője" is a
claim. That is what layer 2 is for.

## 3.2 Layer 2 — model-assisted audit (on demand, owner-triggered)

A "Check consistency" action on the knowledge screen. One model call (not `temperature: 0`; see
§4.4. It is built as described otherwise, in §7.4), with:

- the structured snapshot rendered as authoritative facts,
- the texts fenced exactly as the receptionist fences them,
- a JSON-schema output of `KnowledgeFinding[]` with `origin: "MODEL"`, each required to quote its
  excerpt verbatim (findings whose excerpt is not a substring of the source are discarded — a cheap
  guard against the auditor hallucinating a contradiction).

Cached by a hash of the snapshot, so pressing it twice costs once. Billed to the tenant's AI usage
like a conversation turn and refused when the quota is exhausted (the deterministic layer still
works). Advisory only: it never blocks anything (§5.4).

## 3.3 Acknowledging a finding

Some findings are true and intended — Dr. Kocsis Zoltán may lead the practice without treating
patients. The owner can mark a finding *intended*, which stores
`(tenantId, code, normalisedExcerpt)` in a small `knowledge_finding_acknowledgements` table.
Acknowledgement is keyed on the excerpt, so editing the sentence brings the finding back — on
purpose. An acknowledged `PERSON_NOT_A_PROVIDER` is also passed to the prompt as "named in the
profile but not bookable", so the model can answer "who is Dr. Kocsis?" without offering him.

---

# 4. Runtime: make the assistant follow §2.1 regardless

These make answers right even for a tenant that never opens the health screen.

## 4.1 Structured facts in their own block

`knowledgeContext` splits into two fenced blocks:

- `<bookable-facts>` — rendered from the database only: services with duration, price and the
  providers who offer them; providers; locations with address; per-location weekly bookable hours
  derived from working hours; contact fields; policies. Labelled **authoritative**.
- `<business-description>` — profile, service descriptions, FAQs. Labelled **supplementary: may
  explain the facts above, never adds or overrides one.**

## 4.2 Precedence rules in the prompt

Generalise the existing provider rule in `prompt.ts` to every row of §2.1: if asked what can be
booked, list only `<bookable-facts>` services; if the description mentions a treatment that is not
bookable, say it is not bookable online and offer the bookable service that leads to it; never
state hours, prices, addresses or contacts that are not in `<bookable-facts>`; if a fact is missing
there, say so and point to the contact details.

## 4.3 Consistent language fallback

FAQs fall back to the default locale as the profile already did. The fallback is per kind: the
customer's locale's FAQs if any are active, otherwise the default locale's. Every piece is labelled
with the language it is written in, and the prompt says to answer in the customer's language
whatever the source's.

Per kind rather than all-or-nothing, which the first draft proposed. All-or-nothing would discard an
English profile the owner wrote just because the FAQs were never translated. That is the same
argument `localiseService` makes for falling back per field. The model was never confused by a
Hungarian source. It was confused by not knowing that the text *was* Hungarian, and by getting no
FAQs at all.

## 4.4 Record-rendered answers instead of model prose

**Amended during part 1.** The plan first proposed `temperature: 0`. It cannot be done: the
configured model (`claude-sonnet-5`) does not accept sampling parameters, and
`interpreter.test.ts` already asserts that none is sent. Variation has to be removed by a different
route.

The route was already built. `LIST_SERVICES`, `GET_SERVICE_DETAILS` and `GET_LOCATION_DETAILS` are
answered by `ConversationTools` from the database, and the reply is a template. No model writes
the text, so it cannot drift between two attempts. A `serviceQuery` that matches nothing ("can I
book braces?") falls back to the full bookable list. That is the right answer to K1's question
without any new code. The defect was that the prompt sent "what treatments do you offer?" to
`ANSWER_FAQ`, where the model wrote its own list from the profile. The prompt now routes offering,
treatment and address questions to those intents. `ANSWER_FAQ` is left for what has no structured
home: hours, contact details, policies and the profile's own narrative. Those answers are grounded in
§4.1's facts block, and §4.5 flags them.

## 4.5 Grounding check on answers (log, do not block — v1)

After an `ANSWER_FAQ`, run the layer-1 extractors over the generated answer: person names, cities,
prices, hours. Any that is not in `<bookable-facts>` (or acknowledged in §3.3) sets
`groundingWarning` on the stored message and shows on the transcript in the Conversations screen.
Blocking the reply is deliberately deferred: false positives on a live customer are worse than a
flagged transcript, and §6 gives us the data to decide.

---

# 5. Product surface

## 5.1 Knowledge health panel

On Overview, next to `BusinessKnowledge`: a count of errors and warnings per locale, each finding
with its excerpt, what the record says, which rule, and a link to the screen that fixes it
(Services, Providers, Locations, Availability, or the profile editor). "Check consistency" runs
layer 2.

## 5.2 Inline on save

~~Saving the profile, a service description or an FAQ returns its layer-1 findings in the response,
and the editor shows them under the field.~~ Amended in §7.2: no save response changes. Each knowledge
write invalidates the health query, and each profile field shows its own count from it.

## 5.3 Enabling the assistant

The assistant settings screen shows the health summary. Proposed default: **enabling chat is refused
while any `ERROR` finding is unacknowledged** (`KNOWLEDGE_HAS_ERRORS`, with the list). Already-enabled
tenants are not switched off by a new finding — a provider archived on a Friday must not silently
remove the product's main feature; they get a banner and an email instead. **As built (§7.3): the
refusal and the banner exist; the email does not** — it needs an outbox event, a template in both
locales and a decision on how often to send it, and is left for a later slice.

## 5.4 Saves are never refused

A knowledge save with findings succeeds. Refusing would put the owner's copy hostage to our
heuristics, which will have false positives in Hungarian prose. The single hard gate is §5.3.

---

# 6. Evaluation: making "consistent" measurable

A golden question set in `apps/api/src/modules/assistant/eval/`, HU and EN, run against the real
model in staging (never in CI — it costs money and is non-deterministic) via
`pnpm assistant:eval <slug>`:

- *Milyen szolgáltatásokat kínálnak?* / *What treatments do you offer?*
- *Ki a fogorvos?* / *Who are your doctors?*
- *Hol vannak?* / *Where are you?*
- *Mikor vannak nyitva?* / *When are you open?*
- *Mennyibe kerül a konzultáció?* / *How much is a consultation?*
- *Tudok fogszabályozásra időpontot foglalni?* / *Can I book braces?*

Each question runs **5 times**. Assertions are mechanical, using the layer-1 extractors: every
service, person, city, price and hour mentioned is in `<bookable-facts>`; the five answers agree on
those entities. Output is a pass rate per question. The `wellness` tenant, unfixed, is the first
fixture — it should fail today and pass after §4 with the profile unchanged.

In CI, the fake interpreter covers the deterministic parts (block rendering, fallback, grounding
flags).

---

# 7. Delivery order

| Part | Content | Migration | Notes |
| --- | --- | --- | --- |
| 1 | §4.4 intent routing, §4.3 FAQ fallback, §4.1/§4.2 block split and precedence prompt | No | Fixes most wrong answers for every tenant with no owner action |
| 2 | `@bam/knowledge-engine` layer 1, `GET …/knowledge/health`, health panel, inline findings, authoring help text (K1–K8) in hu/en | No | |
| 3 | §3.3 acknowledgements, §5.3 enable gate | Yes — one table | |
| 4 | §3.2 model audit, §8.4 translation draft | No | Quota-billed |
| 5 | §4.5 grounding flag on transcripts, §6 eval script | Yes — one nullable column on messages | |

## 7.1 Part 1 — as built (2026-10-05)

- `PublicCatalogueService.bookableFacts` is the query. It uses the same predicates as the public
  lists, so the assistant cannot describe a service or person the booking page would not offer.
  Weekly hours are included: they are not otherwise a public read, but every offered slot is
  derived from them.
- `assistant/knowledge-context.ts` holds the pure renderers. `renderBookableFacts` says
  "not recorded" for a missing price, contact or policy rather than omitting the line, so the model
  can tell "unknown" from "absent from the block". `weeklyHours` drops hours at an inactive location,
  as the engine does.
- `AssistantService.knowledgeContext` returns `{ bookableFacts, businessDescription }`. Every prose
  piece is labelled with its language, and FAQs fall back per §4.3.
- `prompt.ts` has two fences, the precedence rules of §4.2 and the routing of §4.4. The provider
  rule is kept and now points at `<bookable-facts>`.
- Verified: `@bam/ai` 17 tests, the API suite 456 passed / 34 skipped (the existing parked suites),
  lint clean. The wellness tenant's facts block was rendered from the local database and matches
  §1.1. **Not verified against the real model.** That is §6's job, and a live chat on staging is the
  first thing to do with this.

## 7.2 Part 2 — as built (2026-10-05)

- **`@bam/knowledge-engine`** — a pure package with no runtime dependencies (rule 8).
  `checkKnowledge(snapshot)` returns `KnowledgeFinding[]`, errors first. `text.ts` holds the
  extractors. Each is deliberately narrow and anchored on something unambiguous:
  - people need a title (`Dr.`, `doktornő`, `főorvos` …);
  - hours need minutes or a unit, so "3-5 alkalom" is not a time;
  - cities match a short list plus a whitelist of Hungarian case endings, so "Vác" does not match
    "vacsora" and "Pécs" does not match "pecsét";
  - offerings are only read from bullet lists under a heading that announces them
    (*Szolgáltatásaink*, *Services* …).

  A missed contradiction is the safe direction. A false one teaches the owner to ignore the list.
- **`GET /v1/assistant/knowledge/health`** (`knowledge-health.ts`) loads exactly what the assistant
  is given, through `PublicCatalogueService.bookableFacts`, and returns `{ errors, warnings,
  findings }`. It has the same `read` guard as the settings `GET`. It is computed on every request.
  The response schema is `knowledgeHealthSchema` in `@bam/contracts`.
- **Overview:** `KnowledgeHealthCard` heads the knowledge section. Each finding shows its source, the
  rule it breaks and, where the fix is on another screen, a link there. The K1–K8 rules are a
  collapsible list in both locales. Each profile field shows how many findings concern its language.
- **Amendments to the plan:**
  - **K5 is one warning, `PRICE_NOT_RECORDED`, not a text-only warning plus a mismatch error.** A
    package price (10.000 Ft for an X-ray inside a 31.000 Ft package) is a true statement that
    matches no service's price. Prose cannot be reliably attributed to one service, so it cannot be
    "wrong" for that service.
  - **A contact and policies form was added (`ContactDetailsCard`).** `PATCH /v1/tenants/current`
    has always accepted `contactEmail`, `contactPhone`, `bookingPolicy` and `cancellationPolicy`, but
    no screen set them. `CONTACT_MISSING` would otherwise have been a finding nobody could fix, and
    Part 1 tells the assistant those fields are where contact details and policies come from. It
    is gated on `tenant:manage` (OWNER only), as the endpoint is.
  - **§5.2 inline findings** come from the health query rather than from each save response (see
    §5.2).
- **The wellness tenant, read from the local database:** 9 errors and 22 warnings. That is every row
  of §1.1 and nothing that is not a real issue: 5 unbookable offerings, Kocsis Zoltán, "Kiss Éva"
  (suggesting Dr Kiss Katalin), Budapest, the 8–20 hours, 8 price lines, the duplicated package, 6
  missing translations, 5 named testimonials, no contact details, and Hauser Max with no hours.
- **Verified:**
  - engine: 16 tests;
  - API: 457 passed / 34 skipped, including a database test that the check sees only its own
    tenant;
  - web: 339 unit tests and all 72 e2e tests, including the new `knowledge-health.spec.ts` in both
    locales;
  - lint and types clean.

  `knowledge-budget.spec.ts` needed a health response in its mock: its catch-all `{ items: [] }`
  crashed the Overview client-side. A real API cannot return that shape.

## 7.3 Part 3 — as built (2026-10-05)

- **Migration `20261005100855_knowledge_finding_acknowledgements`.** One table,
  `knowledge_finding_acknowledgements`, unique on `(tenant_id, finding_key)`. The tenant foreign key
  cascades. `acknowledged_by_user_id` is recorded but has no foreign key, following
  `ProviderDelegation.grantedByUserId`. A row whose key no longer matches anything is inert, so
  nothing prunes it.
- **`findingKey`** (`@bam/knowledge-engine`) is `code | source kind | source id | locale | folded
  excerpt`:
  - changing case or punctuation keeps an acknowledgement; rewording the sentence brings the finding
    back;
  - the same name acknowledged in the profile is still reported in an FAQ.
- **API:**
  - `POST /v1/assistant/knowledge/acknowledgements { key }` accepts only a key the check reports at
    that moment (404 otherwise), so the table only holds what the owner was actually shown.
  - `DELETE /v1/assistant/knowledge/acknowledgements/:id` undoes one.
  - Both use the `manage` guard, write an audit entry, and return the recomputed health.
  - The health response gains `key` and `acknowledgementId` per finding. `errors` and `warnings` now
    count unacknowledged findings only.
- **Gate:** `AssistantService.saveSettings` refuses `enabled: true` with `409 KNOWLEDGE_HAS_ERRORS`
  (`details.errors`) when the assistant is currently off and unacknowledged errors remain. A
  tenant already on is never refused and never switched off. The form always sends `enabled`, so
  refusing every save that carries it would have locked a live tenant out of renaming its persona.
- **Prompt:** an acknowledged `PERSON_NOT_A_PROVIDER` excerpt is listed in `<bookable-facts>` as
  "named, cannot be booked (confirmed by the business)". The provider rule now says such people may
  be described when asked about by name, never offered.
- **Web:**
  - each finding has "Mark as intended";
  - intended ones move to a collapsed list, with Undo;
  - per-field counts ignore intended findings;
  - the Assistant screen warns before the attempt ("cannot be switched on yet"), explains a refusal,
    and tells a live tenant it is running with errors. Each message links to the check.
- **Verified:**
  - engine: 18 tests;
  - API: 459 passed / 34 skipped, including a database test of the whole sequence: refused, a
    made-up key refused, acknowledge, enable, undo, live tenant still saves, reworded sentence comes
    back;
  - web: 339 unit tests and all 76 e2e tests, 6 of them in `knowledge-health.spec.ts`;
  - lint clean, drift check clean.

## 7.4 Part 4 — as built (2026-10-05)

- **`@bam/ai` `knowledge.ts`** adds a `KnowledgeAssistant` interface with an Anthropic implementation
  and a scripted `FakeKnowledgeAssistant`. It has two calls, each with a token count for reserving
  quota beforehand:
  - `audit`: records in `<records>`, each text in its own `<text ref>`, explanations in the
    owner's language;
  - `translate`: one `<item>` per piece, formatting, names, prices and contacts kept as written.

  Both force a tool schema, and the caller parses the result again. A `max_tokens` stop or a
  missing tool call is a failure, never "nothing found". Tenant text cannot open or close a block,
  and a test covers forged `</records>` and `<text>` tags.
- **`KnowledgeAiService`:**
  - Both calls go through the chat's sequence: count, reserve with 10% headroom, call, reconcile.
    They are measured against the **same monthly ceilings** the chat uses, so the owner spends the
    same allowance the customers do, not a second one. A provider failure settles the whole
    reservation, because the provider may have charged for it.
  - **Audit:** `POST /v1/assistant/knowledge/audit { locale }`. It reads the same snapshot as the
    check (`knowledgeSnapshot`, split out of `knowledgeHealth`) and the same `<bookable-facts>` the
    receptionist reads. An excerpt that does not occur in its text, ignoring whitespace, is
    discarded and counted in `discarded`, which the screen shows.
  - **Audit cache:** keyed by a hash of the whole input, in process memory, with at most 200
    entries. **This amends §3.2's "cached" toward the cheap side:** a restart costs one more call,
    and an entry cannot go stale because its key is its content. A table was not worth a migration
    for that.
  - **Translation draft:** `POST /v1/assistant/knowledge/translation-draft { target, kind }`
    translates the default-language profile or its active FAQs. It is all or nothing: a draft
    missing a piece is a 503, because an owner who did not notice would save it half done. It is
    422 when the target is the default language or there is nothing to translate. **Nothing is
    written.**
  - Both use the `manage` guard because they spend money, and both write an audit entry. A cached
    audit does not, since it spends nothing.
- **Web:**
  - an "AI review" block in the knowledge check, with verified points, the discarded count and a
    used-up allowance stated plainly;
  - a "Draft from {default language}" button under each other profile field. It asks before
    replacing text that is already there, and the field carries a "machine-translated, review
    before saving" note until the owner types in it;
  - a FAQ block that drafts a language's FAQs as a list to Add or Discard one by one.
  - service names and descriptions followed later the same day, as a draft button per language in
    each service's Translations panel: [service translation drafts](phase-12-service-translation-drafts.md);
  - and the step before translation — drafting the default-language profile, services and FAQs from
    the organization's own website — is [the site import](phase-12-site-import.md).

  The profile fields were restructured so the buttons and notes sit **outside** each `<label>`.
  Before this, the findings link was inside it and so part of the textarea's accessible name.
- **Verified:**
  - `@bam/ai`: 22 tests;
  - API: 464 passed / 34 skipped, including `knowledge-ai.test.ts` through `buildApp` with the fake:
    cache, invented excerpts, no write from a draft, the all-or-nothing rule, quota refusal before
    any call, settlement on provider failure, and 403 on a plan without the assistant;
  - web: 339 unit tests and all 80 e2e tests, 10 in `knowledge-health.spec.ts`;
  - lint and the drift check clean.

  **Not run against the real model.** The prompts are untested on Anthropic, as Part 1's are.

## 7.5 Part 5 — as built (2026-10-05)

- **`groundingIssues(answer, facts)`** (`@bam/knowledge-engine`) uses the check's narrow extractors on
  the model's own prose. It reports:
  - a titled name that is neither a bookable provider nor an acknowledged person (§3.3);
  - a city that is no location;
  - an hour range that is neither a day's merged bookable period nor the week's earliest-to-latest
    span;
  - a price no service carries.
- **Migration `20261005111151_conversation_grounding_warnings`** adds one nullable `jsonb` column,
  `conversation_messages.grounding_warnings`. It is set only on an `ANSWER_FAQ` reply that names
  something, and only on the stored message, never on the customer's response. Flag, not block, as
  §8.2 decided.
  - The check runs inside the turn. If it throws, the error goes to Sentry and the message is stored
    unflagged: it may never cost the customer the reply.
  - The 90-day retention sweep erases the column with the body, because it holds names.
- **Staff API:**
  - the transcript returns `groundingWarnings` per message;
  - the conversation list returns `flaggedAnswers` per conversation, counted in the same query, so
    an owner can find them without opening each one.
- **Web:** the list marks conversations with flagged answers, and the transcript shows what was named
  with a link to the knowledge check. **A defect found on the way:** the transcript printed each
  assistant message's template key, so every model-written answer read "conversation.answer". It
  now prints the answer text, which is where the flags are worth anything.
- **§6 evaluation, `pnpm assistant:eval <slug> [--runs N] [--locale hu|en|both] [--yes]`**
  (`apps/api/scripts/assistant-eval.ts`):
  - It builds the exact input the chat builds and asks §6's six questions N times per language.
  - Each run is judged **routed** (an expected intent), **grounded** (record-rendered, or an
    `ANSWER_FAQ` with no grounding issue) and **consistent** (the same intent and verdict on every
    run). Answers are printed for a human to read.
  - It spends nothing without `--yes`. It is not metered against the tenant: an operator measuring
    the product is not the tenant using it. The token total and estimated cost are printed instead.
  - It reads only, and never runs in CI. `apps/api/tsconfig.json` now includes `scripts/**/*.ts`,
    so it is typechecked and linted.
- **CLAUDE.md:** the Phase 7/8 withdrawal paragraph now says the receptionist came back.
- **Verified:**
  - engine: 22 tests;
  - API: 465 passed / 34 skipped, including a route test of the flag through a real conversation:
    the flagged answer is delivered unchanged and unmarked, the clean answer has no flag, and the
    list counts 1;
  - worker: 162 tests, with retention now asserting the column is erased;
  - web: 339 unit tests and all 82 e2e tests;
  - lint and the drift check clean;
  - the eval's dry run against the local `wellness` tenant prints its plan (60 calls).

## 7.6 What is not done

1. **Nothing here has met the real model.** Parts 1, 4 and 5 change what Anthropic is sent and how
   its answers are judged, and every test uses a scripted stand-in. The first step is
   `pnpm assistant:eval wellness --yes` on staging, with the wellness texts **unfixed**, to see
   whether §4's routing and precedence alone produce grounded, consistent answers. Then compare with
   the texts fixed per §9.
2. **§5.3's email** to an already-live tenant when a new error appears. The banner on the Assistant
   screen covers it until then.
3. §6 originally pulled the eval forward into part 1 to measure before and after. It was built last
   instead, so the "before" can only be measured by running it against `c45d163`, the commit before
   part 1. The script itself would need to be copied in, since it does not exist there. The useful
   comparison now is unfixed against fixed texts, as in item 1.

---

# 8. Decisions (settled 2026-10-05)

1. **§5.3 enable gate — refuse.** Enabling chat is refused while any `ERROR` finding is
   unacknowledged. A tenant already enabled is not switched off by a new finding (banner and email
   instead), as §5.3 proposes.
2. **§4.5 grounding — flag only.** A generated answer naming something not in `<bookable-facts>` is
   delivered unchanged and flagged on the transcript. Replacing it is not built.
3. **K8 testimonials — flag only.** `PERSONAL_DATA` is a `WARNING`; the text is still sent to the
   model. Nothing is stripped automatically — the owner's copy is the owner's.
4. **K7 translation draft — yes.** A "Draft translation" action per locale fills the profile editor
   (and, separately, the FAQ list) with a machine translation from the default locale. It is a
   **draft**: nothing is saved until the owner saves it, the editor marks it as machine-translated
   until edited, and saving goes through `withKnowledgeBudget` like any other write. One model call,
   `temperature: 0`, billed to the tenant's AI usage and refused when the quota is exhausted —
   delivered with the audit in part 4, since both are owner-triggered, quota-billed model calls.

# 9. Data fix for `wellness` (independent of the code)

Not code, and not ours to do without the owner, but listed so the demo stops misleading:
replace "Budapest" with Szentendre; remove "Nyitvatartás" or align it with working hours (and give
Hauser Max hours or archive him); turn "Szolgáltatásaink" into "treatments planned at the
Konzultáció" or add the services; settle Dr. Kocsis Zoltán's and "Kiss Éva"'s relation to the
providers; move the Start csomag to the service only and set its price; set contact email and
phone; drop the testimonials' names; add EN profile and a handful of FAQs.
