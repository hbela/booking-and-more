# Multi-Tenant AI Receptionist for booking-and-more

Status: Implemented locally, pending web production-build unlock and environment rollout  
Implementation date: 2026-08-20

## Original implementation plan

### Summary

Implement a tenant-aware AI receptionist based on Sunshine Dental’s chat and the reusable parts of booking-and-more’s reverted `a6b754e` implementation.

Each eligible tenant receives:

- A public `/{locale}/{tenantSlug}/chat` page.
- An iframe-based floating widget for external websites.
- FAQ, service, provider, location, and policy answers.
- Booking, rescheduling, and cancellation through the existing booking engine.
- Owner/admin settings, transcripts, outcomes, and usage reporting.
- Starter and Professional plan quotas with automatic fallback to the classic booking form.

Keep chat independent from `BookingFlow`; both paths share booking services, holds, constraints, and confirmation behavior without sharing UI state.

### Core Architecture and Data

- Restore `@bam/conversation-engine` from `a6b754e`: deterministic date resolution, collected booking state, pending-action lifecycle, confirmation rules, and model-independent tests.
- Restore the `@bam/ai` provider interface and fake implementation, but replace the old OpenAI adapter with an Anthropic streaming adapter. Select the production model through `ANTHROPIC_CHAT_MODEL`.
- Add chat-only versions of the reverted tenant-scoped models:
  - `ConversationSession`: tenant, hashed resume token, locale, timezone, state JSON, status, linked customer/hold/booking, activity and expiry timestamps, outcome.
  - `ConversationMessage`: tenant, session, sender, text/structured payload, token usage, timestamp.
  - `ConversationPendingAction`: validated arguments, customer-visible preview, status, expiry, confirmation timestamp.
  - `TenantAssistantSettings`: enabled state, persona name, business description, supported locales, escalation message.
  - `TenantAssistantFaq`: tenant, locale, question, answer, active/order fields.
  - Chat usage events, monthly aggregates, and short-lived quota reservations.
- Reintroduce only chat-related enums/tables in a new forward migration; do not reverse the existing removal migration or restore voice tables.
- Build the prompt from platform safety rules plus current tenant data: branding/contact details, policies, active localized services, public providers/locations, and structured FAQs. Tenant-authored text is treated as quoted business data, never as system instructions.
- Use an explicit tool allowlist:
  - Read: list services/providers/locations, search slots, read authorized booking context.
  - Prepare: create hold and prepare booking, reschedule, or cancellation previews.
  - Confirm: execute exactly one live pending action using the existing booking services and database constraints.
- Never let the model persist IDs as the source of truth, calculate availability, bypass holds, or perform writes directly.
- Resume tokens are 32 random bytes, returned once and stored only as SHA-256 hashes. Wrong token, tenant mismatch, expiry, and unknown conversation all return the same 404.
- Booking-management tokens are accepted only when creating chat from the existing secure management-link screen. Verify them immediately, associate the authorized booking, then discard them; never store them in session state, messages, logs, URLs, or model context.
- Default safeguards: 2,000-character messages, 40 turns per conversation, 24-hour idle expiry, 10 conversation creations/IP/minute, and 20 turns/session/IP/minute.

### APIs and User Experience

- Add public contracts and routes:
  - `GET /v1/public/tenants/:tenantSlug/assistant` — safe availability, greeting, locales, and branding.
  - `POST /v1/public/tenants/:tenantSlug/conversations` — start or management-link-authorize a session.
  - `GET /v1/public/tenants/:tenantSlug/conversations/:id` — resume transcript with `X-Conversation-Token`.
  - `POST .../:id/messages` — stream SSE events: text deltas, tool activity, pending-action preview, completion, and typed errors.
  - `POST .../:id/actions/:actionId/{confirm|cancel}` — explicit action handling; confirmation also requires `Idempotency-Key`.
- Add authenticated owner/admin routes:
  - `GET/PATCH /v1/assistant/settings` and FAQ CRUD.
  - `GET /v1/conversations`, `GET /v1/conversations/:id`, and `GET /v1/conversations/stats`.
  - Add `assistant:manage` and `conversation:read:all`; grant both only to OWNER and ADMIN.
- Add `ChatPanel` as a client component using the existing semantic design tokens and UI primitives. It renders streaming bubbles, tool progress, structured slot choices, confirmation cards, errors, reset/resume, and an always-visible “Use booking form” fallback.
- Add the dedicated tenant chat route and an “Ask the assistant” action on booking-management pages so authorized reschedule/cancellation context can be transferred securely.
- Provide `/chat-widget.js`, configured with tenant slug, locale, and position. It injects an iframe pointed at the hosted chat route, avoiding customer-domain API CORS changes; use strict-origin `postMessage` only for open/close/resize events.
- Add a dashboard Assistant screen with Settings and Conversations sections, usage/quota display, transcript detail, linked booking/customer, outcome, and filters.
- Support the existing English and Hungarian catalogs in v1, with each tenant enabling either or both.
- Make assistant enablement the conjunction of tenant setting, active tenant entitlement, provider configuration, and remaining quota. Any failure hides/disables chat and leaves the classic form working.
- Restore the previous quota levels: Starter 2M input/400K output tokens monthly, Professional 20M/4M, Internal uncapped. Reserve estimated input plus maximum output atomically before a paid call, then reconcile to provider-reported usage so concurrent requests cannot overspend the ceiling.
- Extend worker retention to expire sessions/actions and purge message bodies, structured payloads, and generated summaries after 90 days while retaining non-PII usage aggregates.

### Verification and Rollout

- Unit-test command-envelope validation, state transitions, deterministic relative-date/DST handling, pending-action expiry, prompt composition, entitlement tables, quota reservation/reconciliation, and token hashing.
- API-test FAQ answering, multilingual turns, streaming, refresh/resume, turn limits, missing Anthropic configuration, provider failure, client disconnect, and quota exhaustion.
- Prove tenant isolation for every conversation/settings/log query, including forged IDs, valid tokens from another tenant, and cross-tenant service/provider IDs.
- Exercise booking, approval-required booking, slot collision, reschedule, and cancellation end-to-end. Assert every write needs a named preview and confirmation and still relies on the existing booking constraints and idempotency behavior.
- Assert management tokens never appear in persisted messages, state JSON, logs, model requests, or staff responses.
- Test widget embedding on the existing demo customer site, both locales, mobile layout, iframe messaging, tenant branding, and fallback to the normal booking page.
- Test owner/admin authorization, transcript pagination/filtering, 90-day purging, and concurrent quota requests.
- Run the complete monorepo lint, typecheck, test, build, migration drift, and web end-to-end suites.
- Ship disabled by default, configure Anthropic in staging, enable an Internal tenant as a canary, review tool failures/cost/booking conversion, then allow Starter and Professional owners to enable it.
- Preserve the target repository’s current uncommitted provider auto-confirmation work and create the migration against that resulting schema.

### Assumptions

- V1 is text chat only; voice, document upload/RAG, live-agent takeover, and unrestricted tenant-authored system prompts are excluded.
- Reschedule/cancel authorization requires the existing secure management link; ordinary widget conversations can book and answer questions but direct customers to that link for managing an existing booking.
- Conversation logs and configuration are restricted to OWNER and ADMIN.
- The AI layer is provider-neutral, with Anthropic as the only production adapter initially.

## Execution summary

The multi-tenant AI receptionist was implemented in `C:\devs\prods\booking-and-more` while preserving the repository’s existing uncommitted provider auto-confirmation work.

### Delivered

- Restored `@bam/conversation-engine`, including deterministic date resolution, booking-state collection, pending-action lifecycle, confirmation rules, and model-independent coverage.
- Restored the provider-neutral `@bam/ai` interface and fake provider. The production adapter now uses Anthropic streaming and selects its model through `ANTHROPIC_CHAT_MODEL`.
- Added the forward-only migration `packages/db/prisma/migrations/20260820120000_multi_tenant_ai_receptionist/migration.sql` for chat settings, FAQs, sessions, messages, pending actions, usage aggregates, and quota reservations.
- Added secure 32-byte resume tokens stored only as SHA-256 hashes, with indistinguishable 404 responses for invalid conversation access.
- Added one-time management-token exchange. The token is verified when chat starts and is not retained in session state, messages, model context, logs, URLs, or staff responses.
- Added tenant-safe prompt composition that fences tenant-authored content as untrusted business data.
- Added the explicit read, prepare, and confirm tool flow. Live booking, rescheduling, and cancellation writes execute only after a named preview and explicit confirmation, through the existing booking services, holds, constraints, and idempotency behavior.
- Added public assistant/session/resume/message/action APIs and SSE events for text deltas, tool activity, action previews, completion, and typed errors.
- Added atomic quota reservation and reconciliation for Starter and Professional limits, with Internal uncapped and safe fallback when quota or provider configuration is unavailable.
- Added OWNER/ADMIN permissions and APIs for settings, FAQs, conversation lists/details, usage, outcomes, and statistics.
- Added the standalone `ChatPanel`, localized tenant chat page, session resume, structured slot/action cards, and an always-visible classic booking-form fallback.
- Added the iframe widget and strict-origin/source `postMessage` handling for open, close, and resize events.
- Added secure “Ask the assistant” handoff from booking-management pages.
- Extended worker retention to expire sessions/actions and redact message bodies, structured payloads, and generated summaries after 90 days while retaining non-PII usage aggregates.
- Added environment and compose wiring. The assistant remains disabled unless the tenant setting, entitlement, provider configuration, and available quota all permit it.

The old voice tables and public voice routes were not restored. Historical `VOICE` enum members remain as inert schema/migration compatibility values because destructively narrowing existing database enums was outside the authorized migration scope; public contracts accept chat only.

### Verification completed

- API suite: 360 passed, 34 skipped.
- Focused conversation and quota tests: 22 passed.
- Worker conversation-retention tests: 5 passed.
- AI package tests: 13 passed.
- Contracts and conversation-engine tests: 127 passed (79 contracts, 48 engine).
- Lint and typechecks for the modified packages passed.
- Full monorepo typecheck passed.
- API and worker production builds passed.
- The migration applied successfully to the local test database, and migration drift reported no difference.

An initially outdated quota assertion was corrected after creation-time quota hiding was introduced; the full API suite then passed. Other package suites observed during the monorepo run were green, but a complete final monorepo test rerun was not claimed.

### Remaining rollout items

- The web production build is blocked before compilation by a Windows `EBUSY` lock on `apps/web/.next/standalone/apps/web`. Web lint and typecheck pass, but the build must be rerun after the process holding that directory releases it.
- Web end-to-end tests remain pending because the production-build lock prevented completing the web verification sequence.
- Staging Anthropic configuration, Internal-tenant canary enablement, operational review, and Starter/Professional rollout require deployment credentials and an external environment and were not performed locally.
