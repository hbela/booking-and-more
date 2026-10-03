# Phase 9 — The owner as a provider, and providers at two organizations

**Document version:** 1.0 — built 2026-10-02.
**Scope:** two staffing facts the membership model already half-allowed and the product did not. An
owner who also treats patients can hold their own diary, and a provider can work at more than one
organization. A person who owns an organization may not also be a provider at somebody else's, and
that rule is enforced in both directions.
**Depends on:** [phase-9-provider-onboarding.md](phase-9-provider-onboarding.md) §2.7 (the link is made
inside the acceptance transaction) · [phase-1-authentication-and-tenancy.md](phase-1-authentication-and-tenancy.md)
(a role belongs to a membership, CLAUDE.md rule 9) ·
[phase-3-4-diary-delegation.md](phase-3-4-diary-delegation.md) §2.4 (the grant set lives inside the
membership, which is also why nothing here needs a cross-tenant permission).
**Status:** built and tested against the local database; no manual walk yet (§5).

## 1. What was already true, and what was not

| Need                                                 | Model            | Product before this                                                                                                                                                                                                                       |
| ---------------------------------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| An owner owns several organizations with one address | yes              | Done (tenant switcher, one-step acceptance for existing accounts)                                                                                                                                                                         |
| A platform admin holds no organization               | yes              | Done (rule 9, both directions)                                                                                                                                                                                                            |
| An owner works as a provider in their own clinic     | yes              | **No.** OWNER already holds every `:own` permission and `Membership.providerId` is not role-restricted, but creating a provider with the owner's own address was rolled back, because the automatic invitation refuses an existing member |
| A provider works at two organizations                | yes              | Nothing refused it, nothing tested it                                                                                                                                                                                                     |
| …unless they own an organization                     | no rule anywhere | **No.** Nothing refused it                                                                                                                                                                                                                |

So the first feature needs no schema change and no permission change. It needs the product to stop
refusing a link that the model always allowed. The second needs one new rule.

## 2. Decisions

### 2.1 An owner's diary is a link, not a second membership

`@@unique([tenantId, userId])` allows one membership per person per tenant, and it stays that way. An
owner who treats patients is an OWNER membership whose `providerId` names their diary. Two
alternatives were rejected:

- **A second, PROVIDER membership.** It would break the unique index, and every request would have to
  choose between two actors for the same person in the same tenant.
- **Demoting to PROVIDER and granting extra permissions.** Billing and staffing are OWNER-only (PRD
  §9.2, delegation §2.3), and a role cannot be "PROVIDER plus billing" without becoming a fourth role.

OWNER already holds `availability:manage:own`, `booking:*:own` and `integration:manage:own`, so the
link needs no change to `ROLE_PERMISSIONS`. It changes nothing about what the owner may do, because
the `:all` permissions already cover it. What it changes is _which diary is theirs_: the diary is
reachable in the delegation and integration screens as their own, and the Members table names it.

### 2.2 Creating a provider with a member's own address links instead of inviting

`POST /v1/providers` queues an invitation in the same transaction (provider-onboarding, September
update). When the address already belongs to a member of _this_ organization, that invitation could
only ever be refused. So the create now asks a narrower question first:

- the address is a member's, that member holds no diary, and their role can use one
  (`roleCanHoldDiary`: OWNER, ADMIN, PROVIDER) → **link** the membership to the new diary in the same
  transaction, and send no email. That member signs in already; an invitation would be a token for an
  account they have.
- the address is a member's and none of the above → refuse, as before, and roll the create back.
- otherwise → invite, as before.

The response gains `onboarding: "INVITED" | "LINKED"`, so the screen does not say "invitation sent"
when none was sent.

**ASSISTANT is not linked.** That role holds no `:own` permission, so linking would grant a diary that
matches nothing, which is exactly the silent no-op phase-9-provider-onboarding exists to remove.

### 2.3 "This is me" on an existing provider

The owner whose provider row was created under a different address (a practice inbox, say) needs a
way to claim it. The Providers screen shows **This is me** on any live provider that has no login,
when the caller holds `member:manage` and no diary of their own. It calls the existing
`PATCH /v1/members/:id { providerId }` on the caller's own membership. That route already allows
self-linking, because a link grants a strict subset of what a member-manager holds.

The Members table offers the same picker on OWNER and ADMIN rows, plus **Unlink**. The picker stays
optional there; the amber "no diary" warning remains a PROVIDER-only state.

### 2.4 Owner here, provider elsewhere: refused in both directions

> A person who owns an organization may not be a provider at another one, and a provider at one
> organization may not become the owner of another.

A **provider membership** is one whose role is PROVIDER, or which holds a diary and is not an
OWNER. ADMIN with a diary counts, because a diary is what makes somebody a provider. OWNER with a
diary does not: that is §2.1, and an owner of two clinics who treats patients at one of them is
still only an owner.

Statuses are not filtered. A SUSPENDED membership can be reactivated by its organization alone, and
reactivation is a write in a tenant that the other organization never sees. Ignoring suspended rows
would let the rule be beaten by waiting.

**Where it is enforced.** Every write that can give a person a role or a diary does it:

| Path                                      | Check on                         |
| ----------------------------------------- | -------------------------------- |
| `claimInvitation` (both accept routes)    | the membership being created     |
| `changeRole`                              | the role after the change        |
| `linkProvider`, and §2.2's link on create | the diary after the change       |
| `POST /v1/tenants` (self-serve create)    | the OWNER membership             |
| platform provisioning                     | a pre-check, for the operator    |
| `pnpm db:join-tenant`                     | duplicated comparison, see below |

The rule itself is one pure function, `findCrossTenantRoleConflict` in `@bam/auth/policy`, with its
reasoning in one place. `join-tenant.ts` duplicates the comparison rather than importing it, for the
reason `grant-platform-admin.ts` already records: `@bam/auth` depends on `@bam/db`, so the import
would be cyclic.

**Concurrency.** Two acceptances in two organizations at the same moment would each read the other's
row as absent. Each enforcing write first takes `SELECT … FOR UPDATE` on the person's `users` row, so
writes for one person serialise and writes for different people do not contend. This is the
user-scoped version of rule 14's "the database decides", using the row lock as the arbiter because
the rule spans tables no single constraint can see.

**What the inviter learns.** Invitations are _not_ checked at issue. Refusing at issue would tell
clinic B that a given address owns clinic A, which is another customer's information. The refusal
happens at acceptance, to the person it is about, who already knows what they own. The cost is that
an invitation can be issued that cannot be accepted. The invitation stays PENDING, the invitee is told
why, and the inviter can revoke it. Platform provisioning _is_ pre-checked, because an operator may
see every tenant.

The error is `MEMBERSHIP_ROLE_CONFLICT` (409). It is a new code rather than `FORBIDDEN`, because the
invitation page already reads 409 `FORBIDDEN` as "signed in as the wrong person" and would offer to
sign them out. That is the wrong way out of this problem.

### 2.5 An invitation never demotes an owner

`claimInvitation` upserts, and its update branch takes the invited role. An OWNER who accepts a lower
invitation into their own organization would be demoted without `assertNotLastOwner` ever running,
which could leave the organization with no owner. Before this slice that needed an unusual
sequence. With owners now holding diaries, it is one confused click away. So the upsert keeps OWNER
when the existing membership is OWNER, and still applies the diary link.

## 3. What was built

1. `@bam/auth`: `roleCanHoldDiary`, `isProviderMembership`, `findCrossTenantRoleConflict`, with tests.
2. `@bam/contracts`: `MEMBERSHIP_ROLE_CONFLICT`.
3. API: a `role-compatibility.ts` helper that takes the user lock and asks the policy. Wire it into
   §2.4's paths. Implement §2.2 in `MembershipService.linkOrInviteProvider` and §2.5 in
   `claimInvitation`.
4. Web: §2.3 on the Providers and Members screens. Show the "linked, no email sent" message on
   create, and a localized refusal on the invitation page. Add en + hu keys.
5. `join-tenant.ts`: the duplicated comparison.
6. Integration tests: owner-as-provider create and claim; provider at two organizations; the four
   refusal directions; no demotion on acceptance.

## 4. Not done

- **No cross-organization view for a provider.** Somebody working at two clinics switches between
  them with the tenant switcher, and sees one diary at a time. A combined "my week across every
  clinic" is a reasonable next step, and it is a read-model question rather than a permissions one.
- **Overlap between the two clinics' schedules is not detected.** Each organization's exclusion
  constraint covers its own capacity. Nothing stops the same person being booked at 10:00 in both.
  Closing that needs either Google Calendar part 2's busy-time reading or a person-level capacity
  resource, and both are larger than this slice.

## 5. Verification

- `packages/auth/src/policy.test.ts` — the rule itself: diary-capable roles, what counts as a provider
  membership, both refusal directions, the symmetric "neither order reaches the state" case, and the
  same-organization exemption.
- `apps/api/src/owner-as-provider.test.ts` — 12 cases through real HTTP against
  `booking_and_more_test`. Covered: an owner creating a provider with their own address (LINKED, still
  OWNER, no invitation or outbox row); claiming and releasing an existing diary; an ASSISTANT refused a
  diary; acceptance not demoting an owner; one person as PROVIDER at two organizations. Refused, with
  `MEMBERSHIP_ROLE_CONFLICT` and nothing written: an owner accepting a provider invitation elsewhere
  (the invitation stays PENDING), a provider elsewhere creating an organization, a provider elsewhere
  promoted to OWNER, an owner elsewhere given a diary as ADMIN, and the same link attempted through
  provider creation (the provider is rolled back). Allowed: an owner of two organizations holding a
  diary in one of them.
- `apps/api/src/provider-onboarding.test.ts` — the rollback case used the owner's own address as its
  "cannot be invited" example, which §2.2 now links. It now uses a member who already holds a diary.
- Whole API suite 448 passed, web 332 passed, `pnpm lint` and `pnpm check-types` clean,
  `db:drift-check` clean. No migration: nothing in this slice changes the schema.

**Not covered by an automated test:** the platform provisioning pre-check (§2.4 table) and
`db:join-tenant`'s duplicated comparison. Neither can produce the forbidden state unaided, because
acceptance enforces the rule regardless. The screens (§2.3) have only their pure state module under
test, `member-diary.test.ts`.

**Manual walk, not yet done:** as an owner, add a provider with your own address and check the
success message says "linked". Then open Availability for that diary. On the Members screen, unlink it
and link it again. Separately, invite an owner of a second test organization as a provider, and check
the invitation page shows the role-conflict text rather than the "wrong account" sign-out offer.
