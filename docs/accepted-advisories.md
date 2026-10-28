# Accepted security advisories

`pnpm audit --prod --audit-level high` runs first in CI, so one unfixed advisory skips
every later check (lint, types, tests, build). A fix that cannot ship the same day is
recorded here **and** in `pnpm.auditConfig.ignoreGhsas` in the root `package.json`.
Both entries go together, and both are removed together.

An advisory may be accepted only when it cannot be exploited in this codebase's
configuration. The reason must name what is absent, and a follow-up must exist to
remove the entry.

## Better Auth 1.6.25 (accepted 2026-10-28)

The fix is Better Auth ≥ 1.7.7. 1.7 is not a drop-in upgrade: accounts require a new
`issuer` column with an account-identity backfill, which is a Prisma migration under
rule 1, and OAuth flows are reworked. That upgrade is tracked separately in the
[production tasklist](production-deployment-tasklist.md), §4.

`packages/auth/src/auth.ts` configures **no Better Auth plugins**: email and password,
plus an optional Google `socialProviders` entry, through `@better-auth/prisma-adapter`.

| Advisory                                                                 | Severity | Requires                                                                            | Here      |
| ------------------------------------------------------------------------ | -------- | ----------------------------------------------------------------------------------- | --------- |
| [GHSA-965c-763c-88jm](https://github.com/advisories/GHSA-965c-763c-88jm) | critical | The **Magic Link** plugin, plus a social provider, plus database-stored OAuth state | No plugin |
| [GHSA-r4xp-prcw-77qf](https://github.com/advisories/GHSA-r4xp-prcw-77qf) | high     | The **OAuth Proxy** plugin                                                          | No plugin |
| [GHSA-q84f-53jg-9ppm](https://github.com/advisories/GHSA-q84f-53jg-9ppm) | high     | The **device authorization** plugin                                                 | No plugin |
| [GHSA-44jh-23m7-hpcf](https://github.com/advisories/GHSA-44jh-23m7-hpcf) | low      | The **Drizzle or Kysely** adapter                                                   | Prisma    |

**This acceptance lapses** the moment someone adds any of those plugins or adapters.
Adding a Better Auth plugin therefore requires either the 1.7 upgrade or a fresh
reading of each advisory above.

Fixed in the same change, because they _were_ exploitable or could become so: `next`
16.3.8 → 16.4.3 (two unauthenticated RCEs and an App Router DoS), `@sentry/nextjs` and
`@sentry/node` → 10.78.0 (a tunnel-route middleware bypass, and the web uses the
`/api/monitoring` tunnel), `zod` → 4.6.7, `fastify` → 5.12.7, `fast-uri` overrides →
3.1.9 / 4.2.3, `vitest` → 4.1.12, and a `vite` override → 8.1.6.
