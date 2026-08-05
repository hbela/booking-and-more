This is the execution record for the second delivery phase, derived from PRD.md §9.2 and technical-implementation.md §44 (Epic 1).

# Phase 1 — Authentication and Tenancy

## Implementation Record

**Document version:** 1.0
**Scope:** Epic 1 — identity, tenants, memberships, roles, invitations, audit logging
**Depends on:** [phase-0-technical-foundation.md](phase-0-technical-foundation.md)
**Exit criteria:** An owner can create a tenant · An owner can invite an administrator or provider · Users cannot access another tenant's data · Role permissions are covered by tests

---

# 1. Context

Phase 0 delivered a repository with conventions and no features. This phase adds the first real domain: who
someone is, which business they work for, and what they may do there.

Everything later depends on getting this right. An availability engine that leaks another clinic's schedule is
worse than no availability engine, and the predecessor project shipped exactly that — several handlers looked
resources up by ID and never checked the tenant, so any authenticated user of any tenant could read another
tenant's departments and providers.

---

# 2. The central decision: Better Auth owns identity, we own tenancy

Better Auth handles **who you are**: users, sessions, credentials, verification. It handles **nothing** about
what you may do.

We deliberately do **not** use Better Auth's `organization` plugin, though it appears to fit:

1. Our `Tenant` is a domain entity — timezone, booking policy, cancellation policy, branding
   (technical-implementation.md §10.1) — not a generic organisation record.
2. Our `Membership` carries `providerId` and a lifecycle `status` the plugin has no concept of.
3. `booking-for-all` used the plugin _and_ kept its own roles, leaving two role systems that disagreed about
   the same user. `requireOwnerHook` checked the global `User.role` while `requireOrgRole` checked the member
   role, and both were live at once.

The cost is writing membership CRUD ourselves. That is the right trade: it is the part most in need of being
testable and auditable.

## 2.1 A role is a property of a membership

Never of a user. The same person can own one clinic and assist at another, and there is no such thing as
"a PROVIDER" in the abstract.

The one exception is **PLATFORM_ADMIN**, which is deliberately _not_ a role but a boolean on the user.
Operating the platform is not tenant-scoped, and keeping it out of the role enum means it cannot be granted
through the ordinary invitation flow. It is settable only by
`pnpm db:grant-platform-admin <email>`, because Better Auth declares the field with `input: false` — no
sign-up or profile update can write it. There is a test asserting exactly that.

---

# 3. Delivered

## 3.1 `packages/auth`

| File        | Contents                                                      |
| ----------- | ------------------------------------------------------------- |
| `roles.ts`  | `Roles`, `Permissions`, `ROLE_PERMISSIONS`, `INVITABLE_ROLES` |
| `policy.ts` | Pure authorization predicates over an `Actor`                 |
| `auth.ts`   | `createAuth()` — the Better Auth instance factory             |

Permissions are explicit (technical-implementation.md §8.4). Handlers ask "may this actor do X", never "is
this actor an ADMIN", so re-scoping a role means editing one table rather than auditing every route.

`policy.ts` imports nothing from Fastify, Prisma or the network, so every rule is unit-testable and none can
accidentally depend on ambient request state.

### The `:own` distinction

`AVAILABILITY_MANAGE_OWN` never authorises anything by itself. `canForProvider()` grants access only when the
actor holds the `:all` variant, or holds `:own` **and** the resource is theirs. A `PROVIDER` membership whose
`providerId` is still null — the state before Epic 2 — is refused, so an unpopulated field cannot become a
wildcard.

## 3.2 Database

Migrations `20260728143602_identity_and_tenancy` and `20260728143700_invitation_partial_unique`.

- **Better Auth tables** — `users`, `sessions`, `accounts`, `verifications`. Field names stay camelCase
  because the adapter dictates them; fighting that invites "worked until you added a plugin" bugs.
- **`memberships`** — `@@unique([tenantId, userId])`, role, status, `providerId`, `invitedByUserId`.
- **`invitations`** — stores only a SHA-256 `tokenHash`, exactly as for booking management tokens
  (technical-implementation.md §34.4).
- **`audit_logs`** — append-only. No `updatedAt`, and no update or delete path in application code.

### The partial unique index

`@@unique([tenantId, email])` on invitations would be wrong: once an invitation is revoked or expires, that
address could never be invited again. The constraint is therefore hand-written SQL scoped to live rows:

```sql
CREATE UNIQUE INDEX "invitations_tenant_email_pending_key"
  ON "invitations" ("tenant_id", "email")
  WHERE "status" = 'PENDING';
```

## 3.3 API plugins

Registration order is enforced by each plugin's declared `dependencies`:

| Plugin                     | Answers                                                                                   |
| -------------------------- | ----------------------------------------------------------------------------------------- |
| `auth.plugin.ts`           | _Who_ are you — mounts Better Auth at `/v1/auth/*`, resolves the session once per request |
| `tenant-context.plugin.ts` | _Where_ are you, and what is your standing there                                          |
| `authorization.plugin.ts`  | _May_ you — `requireAuth`, `requirePermission`, `requireWritableTenant`                   |
| `audit.plugin.ts`          | Records what happened                                                                     |

### The rule that makes isolation work

A client-supplied tenant identifier is only ever a **hint**. It selects which tenant to look up; it never
asserts access. Access comes from an ACTIVE membership row found server-side.

Resolution happens in one place, or not at all — the predecessor left it to each handler and several simply
forgot. A tenant that exists but the caller cannot see returns the **same 404** as one that does not exist,
so the API is not a tenant-enumeration oracle.

### Session `activeTenantId`

Stored for the tenant switcher's convenience and never trusted for authorization; membership is re-resolved
on every request.

## 3.4 Audit logging

Fire-and-forget and never throws: a failed audit write must not turn a successful booking into a 500.

That is a real trade-off — the trail is best-effort, not transactional. Acceptable for tenant and membership
changes. When Epic 4 audits booking writes, those go through the transactional outbox inside the booking's own
transaction, because there losing the record actually matters.

Snapshots are scrubbed of known-sensitive keys on the way in. Audit rows are a different sink from logs, with
a much longer retention (12 months, technical-implementation.md §35).

## 3.5 Endpoints

```http
POST   /v1/auth/*                              Better Auth (sign-up, sign-in, sign-out, session)
GET    /v1/me                                  identity + tenant standing + effective permissions
POST   /v1/tenants                             create a tenant, becoming its OWNER
GET    /v1/tenants                             tenants the caller belongs to
GET    /v1/tenants/current                     read the selected tenant
PATCH  /v1/tenants/current                     update settings (OWNER only)
POST   /v1/tenants/:tenantId/activate          set the session's active tenant
GET    /v1/members                             list members
PATCH  /v1/members/:membershipId               change a role
DELETE /v1/members/:membershipId               remove a member
POST   /v1/members/invitations                 invite (returns the link once)
GET    /v1/members/invitations                 list pending invitations
DELETE /v1/members/invitations/:invitationId   revoke
POST   /v1/invitations/accept                  accept (outside tenant scope by necessity)
```

`slug` and `status` are absent from the tenant update schema on purpose: the slug is published in booking
links and QR codes, and status is a platform-admin operation, not something an owner sets on themselves.

## 3.6 Web

Sign-in, sign-up, dashboard (tenant switcher, member list, invite panel) and invitation acceptance, in
Hungarian and English.

The dashboard shows and hides controls from `me.permissions`, which the API derives from the same role table
the guards use — so the UI cannot disagree with the API about what is allowed. It remains a UI affordance
only; every action is authorised again server-side.

---

# 4. Safeguards worth naming

| Risk                                              | Safeguard                                                                                | Test                                                        |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Cross-tenant read                                 | Tenant resolved server-side from membership; identical 404 for forbidden and nonexistent | "hides another tenant behind the same 404"                  |
| Privilege escalation at sign-up                   | `isPlatformAdmin` declared `input: false`                                                | "cannot be tricked into granting platform admin at sign-up" |
| Leaked invitation link used by the wrong person   | Invited address must match the signed-in one                                             | "refuses an invitation accepted by the wrong account"       |
| Invitation token recoverable from a database dump | Only SHA-256 hash stored; token returned once                                            | "stores only a hash of the token"                           |
| Token replay                                      | Status flips to ACCEPTED in the same transaction                                         | "cannot be reused after acceptance"                         |
| Tenant stranded with no owner                     | Last-owner guard on demote and remove                                                    | "refuses to demote the last owner"                          |
| Self-promotion                                    | `canChangeMemberRole` refuses self-modification                                          | "refuses self role-modification even for an owner"          |
| Writes to a suspended tenant                      | `requireWritableTenant` runs before permission checks                                    | "rejects writes but still allows reads"                     |
| `:own` permission acting as a wildcard            | Ownership checked separately from the permission                                         | "refuses a provider whose membership is not linked"         |

---

# 5. Deviations and known gaps

1. **Invitations are not emailed.** The accept URL is returned once in the API response and shown once in the
   dashboard. Email delivery needs the notification worker, which is Epic 5. Flagged in the endpoint's own
   OpenAPI description rather than left implicit.

   **Partially closed.** An _owner_ invitation has been emailed since provisioning landed
   (phase-9-saas-administration §1.4), and a _provider_ invitation since 2026-08-04
   ([phase-9-provider-onboarding.md](phase-9-provider-onboarding.md)). What is still true is the generic
   `POST /v1/members/invitations` — inviting an admin or an assistant still means copying a link out of the
   dashboard and pasting it into your own mail client. Kept as an open item rather than deleted, so the
   remaining gap does not disappear along with the part that was fixed.

2. **Email verification is off.** `requireEmailVerification: false` — until there is a way to deliver the
   mail, enabling it would lock every new account out. Turn on in Epic 5.
3. **Rate limiting is per-instance.** In-process store until Redis arrives in Epic 5. `buildApp` takes an
   explicit `rateLimit` option so the integration suite can opt out without an `if (NODE_ENV === "test")`
   buried in the app.
4. ~~**`Membership.providerId` is never populated.**~~ **Closed by Epic 2**, which created the `Provider`
   model and the foreign key, and by
   [phase-9-provider-onboarding.md](phase-9-provider-onboarding.md), which made populating it the same act as
   issuing the invitation rather than a second step on a screen that did not exist. The `:own` permissions
   were inert and tested to fail closed until then.
5. **Audit writes are best-effort**, by design — see §3.4.

---

# 6. Verification

```bash
pnpm lint && pnpm check-types && pnpm test   # 13/13 tasks, 106 tests
pnpm build
pnpm db:drift-check
```

## 6.1 Results — 2026-07-28

| Suite                         | Result                                  |
| ----------------------------- | --------------------------------------- |
| `@bam/auth` policy units      | 28 passed                               |
| `@bam/api` (health + tenancy) | 45 passed                               |
| `@bam/config`                 | 14 passed                               |
| `@bam/contracts`              | 9 passed                                |
| `@bam/observability`          | 5 passed                                |
| `@bam/db`                     | 5 passed                                |
| **Total**                     | **106 passed**, 13/13 turbo tasks green |

## 6.2 Live end-to-end, against the running API

1. Sign up → `/v1/me` returns the user with `tenant: null` and no permissions. ✓
2. Create tenant → creator becomes OWNER; `/v1/me` returns 16 permissions. ✓
3. Invite an ADMIN → acceptance URL returned once. ✓
4. Second user signs up and accepts → joins as ADMIN. ✓
5. ADMIN reads members: **200**. ADMIN patches tenant settings: **403**. ✓
6. Outsider names the tenant explicitly: **404 TENANT_NOT_FOUND** — byte-identical to a nonexistent
   tenant ID. ✓
7. Audit trail contains `tenant.created`, `membership.invited`, `membership.invitation_accepted`, all with
   `actorType USER`. ✓
8. No password, invitation token or connection string anywhere in the API log. ✓
9. Web: `/sign-in`, `/sign-up`, `/dashboard`, `/invitations/[token]` all render; `/hu/*` correctly redirects
   to the unprefixed default-locale path. ✓

---

# 7. Next

Epic 2 — providers, services, locations; provider↔service and provider↔location assignment; and populating
`Membership.providerId`, which activates the `:own` permission paths already written and tested here.
