# Taste

## Environment & tooling
- Develops on Windows with PowerShell as the shell; main repo at `C:\devs\prods\booking-and-more` (pnpm monorepo invoked via `corepack pnpm`, workspace filters like `--filter @bam/web` / `--filter @bam/api`). Confidence: 0.9
- Runs coding agents in a sandbox with approval-gated escalations; expects escalated commands to carry a clear justification and a minimal reusable prefix rule. Confidence: 0.7

## Project: booking-and-more
- Product is Hungarian-first bilingual (hu default locale, en secondary); user-facing copy is maintained in both locales (e.g. `en.json`/`hu.json`, both demo-site languages). The user communicates with agents in English. Confidence: 0.85
- Project conventions live in a repo `CLAUDE.md` as numbered, citable rules (e.g. rule 1: migrations via `prisma migrate dev`, never `db push`; rule 5: every repository query is tenant-scoped; rule 15: booking snapshots record what the customer was told). Consult and follow them. Confidence: 0.85

## Workflow
- Agents must not merge, push, or deploy to production; the user deploys personally, checking with the agent first ("Shall I deploy the app again?"). Confidence: 0.7
- Expects a full verification pass before work is called done — lint, type-check, unit tests, Playwright e2e tests, and a production build — with results reported. Confidence: 0.7
- Kicks off significant design work with parallel research/design-review subagents and expects thorough written analysis (threat model, phased reversible migrations, rollback plan) before implementation. Confidence: 0.65
- Verifies mobile/PWA behavior manually on their own Android phone; agents should flag what still needs on-device verification rather than claiming it works. Confidence: 0.6

## Communication
- Communicates in short, direct, product-focused messages and freely interrupts mid-task to narrow or correct scope. Confidence: 0.6
