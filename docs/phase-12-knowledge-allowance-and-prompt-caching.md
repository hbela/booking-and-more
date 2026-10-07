# Phase 12 — A 30 000-character knowledge allowance, and prompt caching

## Implementation Record

**Document version:** 1.0 — planned and built 2026-10-06.
**Scope:** raise the per-language knowledge allowance from 10 000 to 30 000 characters. Make the
receptionist's prompt cacheable, so the larger block does not triple the cost of every turn. Count
cached tokens at their real weight. Make long translation drafts fit a model call.
**Depends on:** [Phase 12](phase-12-assistant-knowledge-consistency.md) (the two blocks and their
precedence), [site import](phase-12-site-import.md) §8 (the measurements).
**Status:** built. Caching was verified on the real model (§5). **`pnpm assistant:eval` has not been
run on the restructured prompt**, and it must be before this ships (§3.6). §1–§4 are the plan as
approved.

## 1. Why

Testing the site import on koronafogaszat.eu, one Hungarian profile, the Orthodontics service in four
languages and Konzultáció already used 5 600 of the 10 000 Hungarian characters. A real clinic's
treatment descriptions and FAQs need at least 30 000.

Measured on that site, Hungarian runs at about **1.85 characters per token**. So 10 000 characters is
about 5 400 tokens, and 30 000 is about 16 000. The whole block is sent on **every chat turn**.

## 2. What raising only the constant would break

1. **Silent truncation.** `fence()` in `packages/ai/src/prompt.ts` cuts `<business-description>` and
   `<bookable-facts>` at 20 000 characters. The business description is the profile, every service
   description and the FAQs, so at a 30 000 allowance an owner could save text the receptionist never
   reads, and nothing would say so.
2. **Conversations cut off after about four turns.** A turn would carry about 21 000 input tokens, and
   `CHAT_MAX_INPUT_TOKENS_PER_CONVERSATION` (80 000) closes the conversation with `TOKEN_LIMIT` once
   the turns add up past it. Today it is about eight turns.
3. **Twice the cost per turn,** because nothing is cached. With Sonnet 5 at 200 cents per million
   input tokens, a turn's input goes from about 2 cents to about 4.
4. **Translation drafts of a long profile time out.** About 30 000 characters out is about 11 000
   output tokens, roughly two minutes, past the 120 s model timeout.

## 3. Decisions

### 3.1 The knowledge is a cached prefix

The interpreter's system prompt becomes two blocks:

- **Static:** the instructions, `<catalogue>`, `<bookable-facts>` and `<business-description>`. It
  carries `cache_control: { type: "ephemeral" }`.
- **Per turn:** the customer's language and timezone, and the conversation step.

The step changes every turn, and it sat near the top, so nothing after it could ever be cached. Moving
it _after_ the static block is the whole change.

- **Cache key:** tools come first in Anthropic's prefix order and are static. So the cached prefix is
  one tenant's knowledge in one locale, and it is shared by every conversation of that tenant and
  locale within the cache's five-minute life. A turn refreshes it.
- **Cost:** a cache read costs 10% of the input price and a write 125%. After the first turn, the
  knowledge costs about a tenth of what it does today.

### 3.2 Usage counts what a token costs

Once caching is on, Anthropic reports `input_tokens` (uncached), `cache_creation_input_tokens` and
`cache_read_input_tokens` separately. Today only `input_tokens` is read, so caching would make usage
look nearly free.

`tokenUsage` takes all three. `AiUsage.inputTokens` becomes **input-token equivalents**:

> uncached + ⌈1.25 × written⌉ + ⌈0.1 × read⌉

The raw counts ride along as `cacheReadTokens` and `cacheWriteTokens`. No column changes and no
migration: everything downstream already reads `inputTokens`, and now reads it in units of cost. That
covers the monthly allowance, the per-conversation cap, the session's `aiInputTokens` and the
`AI_INPUT_TOKENS` usage rows. `tokenCostMinor` stays right because equivalents × input price is the
input cost.

- **The `AI_INPUT_TOKENS` category changes meaning:** from raw tokens to cost-weighted tokens. This
  is deliberate: the allowance exists to bound cost.
- **Reservations stay an upper bound,** except the first turn of a cold cache, whose equivalents can
  reach 125% of the counted tokens against a 110% reservation. Reconciliation already settles to the
  actual figure; the overshoot is bounded and one-off per cache write.

With these numbers, a conversation reaches about ten turns within the 80 000 cap: the first turn costs
about 23 000 equivalents, later ones about 4 000. So no cap is raised.

### 3.3 The prompt never truncates what the budget allows

`fence()`'s ceiling rises to 45 000 characters per block. That covers the 30 000 allowance plus the
labels the renderer adds (service names, "Q:"/"A:", locale tags), and a test ties the ceiling to
`KNOWLEDGE_CHARACTER_LIMIT`, so raising one without the other fails.

### 3.4 Translation drafts are chunked

`translationDraft` splits any text longer than 4 000 characters at blank lines, then groups pieces
into batches of at most 6 000 source characters. The batches run as parallel metered calls, each about
40 s and well inside the timeout, and the pieces are joined back in order.

All or nothing still holds: a missing piece fails the whole draft.

### 3.5 Copy

The "10,000 characters" hint in both locales takes the limit as a parameter from `KnowledgeUsage`, so
it cannot drift again. The error message stops quoting a number.

### 3.6 Not changed

- The AI review reads every locale at once. At full allowance that is about 120 000 characters, or
  about 65 000 tokens, which is within the model's context. It costs about 13 cents a run and is
  cached by content already.
- The site import's 2 500-character profile target stays: the extra allowance is for service and FAQ
  depth.
- Nothing about the evaluation script. `pnpm assistant:eval` exercises the restructured prompt and
  **must be run on staging before this ships**, because moving the step line is a prompt change.

## 4. Verification

- **`@bam/ai`:**
  - the system prompt is two blocks, the first with `cache_control`, and holds no per-turn text: the
    first block is identical for two inputs that differ only in state, locale and timezone;
  - `tokenUsage` weights cache reads and writes;
  - the fence ceiling exceeds the allowance.
- **API:**
  - knowledge budget tests at 30 000;
  - a 12 000-character profile drafts in chunks and comes back whole and in order;
  - a missing chunk is a 503.
- **Web:** the budget hint shows the limit from the API.
- **Real model,** with one call pair: two consecutive turns of a conversation on a 30 000-character
  tenant. The second turn's `cache_read_input_tokens` should be about the static block.

## 5. As built

- **`@bam/contracts`:** `KNOWLEDGE_CHARACTER_LIMIT` is 30 000.
- **`@bam/ai` `prompt.ts`:**
  - `buildSystemBlocks` returns `{ cached, turn }`. `buildSystemPrompt` is the two joined, kept for
    reading and tests.
  - The cached block now opens by saying the language, timezone and step come at the end. The one
    rule that said "the timezone above" now says "the customer's timezone".
  - `PROMPT_BLOCK_CHARACTER_CEILING` is 45 000.
- **`@bam/ai` `interpreter.ts`:** sends `system` as two text blocks, the first with
  `cache_control: { type: "ephemeral" }`. `countTokens` sends the same blocks; it reports the uncached
  view, which is the reservation's upper bound.
- **`@bam/ai` `pricing.ts`:** `tokenUsage` takes `cacheReadTokens` and `cacheWriteTokens` and returns
  input-token equivalents (§3.2). `CACHE_WRITE_WEIGHT` is 1.25 and `CACHE_READ_WEIGHT` is 0.1. The
  knowledge calls (audit, translation, site import) pass the same fields; they set no cache breakpoint
  today, so the fields stay zero there.
- **API `knowledge-ai.service.ts`:**
  - `splitForTranslation` splits at blank lines; a paragraph longer than a piece is split at line
    breaks, then sentence ends, then cut.
  - `batchPieces` groups pieces greedily.
  - The batches are translated as parallel metered calls, and the result is all or nothing per piece.
  - **Deviation from the plan:** a single paragraph longer than 4 000 characters comes back as several
    paragraphs, because pieces are rejoined with a blank line. This is rare, and the alternative was
    carrying separators through the model.
- **Web:** the budget hint is `{limit}`, formatted in the reader's locale from `KnowledgeUsage.limit`.
  The error copy quotes no number.
- **Tests:** every test that wrote 10 000 now derives from `KNOWLEDGE_CHARACTER_LIMIT`
  (`knowledge-budget.test.ts`, `catalogue.test.ts`), so the next change of the limit is one line.

### 5.1 Measured on the real model (2026-10-06)

Two consecutive interpreter turns with 30 000 characters of koronafogaszat.eu's text as
`<business-description>`. Their steps differed, so the per-turn block differed:

| Turn | Step              | `countTokens` | Input equivalents | Cache           | Est. cost |
| ---- | ----------------- | ------------- | ----------------- | --------------- | --------- |
| 1    | START             | 18 343        | 22 862            | wrote 18 075    | 5         |
| 2    | SELECTING_SERVICE | —             | **2 079**         | **read 18 075** | 1         |

- **The step change did not break the cache.** That is the point of §3.1.
- **Within the 80 000 per-conversation cap:** after a 22 862 first turn, later turns at about 2 000 to
  4 000 leave room for well over ten turns. The cap is unchanged.
- **The first turn's equivalents (22 862) exceed its reservation** (18 343 × 1.1 = 20 177) by about
  13%, as §3.2 expected. It is settled to the actual figure.

## 6. Both numbers are environment variables (2026-10-07)

This supersedes §5's "`KNOWLEDGE_CHARACTER_LIMIT` is 30 000 in `@bam/contracts`" and the
`PROMPT_BLOCK_CHARACTER_CEILING` constant in `@bam/ai`. Both now come from `@bam/config` (rule 3), with
the same defaults:

| Variable                         | Default | Read by                    |
| -------------------------------- | ------- | -------------------------- |
| `KNOWLEDGE_CHARACTER_LIMIT`      | 30 000  | the API's knowledge budget |
| `PROMPT_BLOCK_CHARACTER_CEILING` | 45 000  | the receptionist's prompt  |

- **The ceiling is checked at boot.** `loadEnv` refuses a ceiling below ⌈1.4 × limit⌉ and names the
  minimum. This replaces the test that used to tie the two constants: a deployment can now set them
  independently, so the check has to run where they are set.
- **The ceiling is a required interpreter setting.** `AnthropicIntentInterpreter` takes
  `IntentInterpreterConfig`, whose `promptBlockCharacterCeiling` is required, and
  `buildSystemBlocks(input, ceiling)` takes it as an argument. A construction site that forgets it fails
  to compile, rather than truncating at a number other than the deployment's. `app.ts` and
  `scripts/assistant-eval.ts` both pass the variable.
- **The limit is set once, at the composition root.** `buildApp` calls
  `configureKnowledgeBudget({ limit })` before any route. A dozen call sites in three services reach the
  budget, and threading the value through every constructor would leave a forgotten one silently on a
  default.
  - Until configured, every read throws ("used before `configureKnowledgeBudget()`"), so a path that
    bypasses the composition root fails loudly instead of guessing.
  - Tests that use the services directly configure it themselves.
- **`@bam/contracts` no longer exports a limit.** The web never needed one: it shows `limit` from the
  knowledge-usage response.
- **Deployment surfaces:** both variables are in `.env.example`, `docker-compose.coolify.yml` and
  `docker/docker-compose.yml`. The compose files enumerate variables, so one missing there would never
  reach the container.
- **Verified:**
  - `@bam/config` tests the defaults, an override, and the refusal;
  - `catalogue.test.ts` boots the app with `KNOWLEDGE_CHARACTER_LIMIT=12000` and sees 12 000 enforced,
    reported in `/v1/services/knowledge-usage`, and named in the error;
  - the prompt test cuts at the ceiling it is given.
