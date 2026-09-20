# Production environment decision

Decision recorded on 2026-09-20: the owner confirmed that production should start
with an empty database. Keep all existing staging data. This supersedes the
original plan to convert the existing server database into production.

## Recommended Coolify layout

Keep the existing `booking-and-more` project and separate its resources into
`staging` and `production` environments. The environment label is organizational;
both deployments may correctly use `NODE_ENV=production`.

| Environment | Application                                     | Data and billing                                                          |
| ----------- | ----------------------------------------------- | ------------------------------------------------------------------------- |
| staging     | Existing `booking-and-more:main`                | Existing isolated database/Redis, Stripe test mode                        |
| staging     | Existing `hbela/booking-and-more:wellness-demo` | Retain the current demo configuration; inspect dependencies before moving |
| production  | New `booking-and-more:production`               | New empty PostgreSQL/Redis volumes, separately configured live billing    |

The current environment named `production` contains the staging resources. Rename
it to `staging`, then create the real `production` environment after reviewing any
shared variables and resource relationships. These changes have not yet been made.

The compose application includes its own PostgreSQL and Redis. The separately
listed Coolify database named `booking-and-more` must not be assumed to be the
application's active database. Confirm consumers before changing or removing it.

Use the reviewed compose definition for the new production application. A Coolify
clone can copy configuration, but does not copy persistent data. Review copied
domains, secret values, volume paths, database/Redis addresses and scheduled tasks
before starting it. Never share writable staging and production volumes or queues.

## Release sequence

1. Review and commit the working changes on a release branch. Exclude secrets,
   local logs/helpers, `.claude/` and `.commandcode/`; review formatting-only changes.
2. Push the release branch and require passing CI, including Linux ARM64 images.
3. Before merging into `main`, review all deployment triggers. At inspection,
   `booking-and-more:main` had auto-deploy disabled but `wellness-demo` had it enabled.
4. Validate the selected revision in staging. Its existing data still needs
   encryption keys, maintenance and PII conversion before encryption-aware code
   can read it. Starting production empty does not authorize resetting staging.
5. Create the new production stack with distinct volumes, domains, authentication
   and encryption keys, integration credentials, and invite-only owner access.
6. Apply all migrations to the empty production database. Existing-data PII
   backfill and test-billing transition are unnecessary for this empty database;
   verify zero legacy rows. New customer writes must use encryption immediately.
7. Establish backups, separate key recovery, alerting and a timed restore drill
   for the NEW resource and volumes. Previously staged backup identifiers refer
   to staging and must not be reused blindly.
8. Verify live billing prices, production Stripe webhook delivery, email,
   Billingo configuration and deployed smoke checks before opening the cohort.
9. Promote the tested release by immutable revision with deployment triggers kept
   controlled. A `production` application name does not require a Git branch named
   `production`; `main` can be the source with manual promotion of a tested commit.

No application, environment, volume or database has been created, moved, renamed
or deleted as part of recording this decision. Release commits and pushes are
tracked in Git; this document is not a deployment completion record.
