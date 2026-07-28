#!/usr/bin/env node
/**
 * Fail if the committed migrations do not reproduce the current schema.prisma.
 *
 * This is the single most important CI step in the repository.
 *
 * Background: the predecessor project applied a schema change with `prisma db
 * push` plus a backfill script, leaving behind a migration file that contained
 * nothing but a comment. Production and the schema diverged silently for weeks.
 * `prisma migrate status` does NOT catch this — it only reports which
 * migrations have been *applied*, not whether applying them reproduces the
 * schema. `prisma migrate diff` does.
 *
 * Connection and shadow-database URLs come from prisma.config.ts, which is the
 * one place that owns them.
 *
 * Exit code 2 from `--exit-code` means "there is a difference", which for us
 * means someone changed schema.prisma without generating a migration.
 */

import { spawnSync } from "node:child_process";

// Passed as one string rather than a command plus an args array: `shell: true`
// is required on Windows to resolve pnpm.cmd, and combining it with an args
// array triggers Node's DEP0190 warning. No value here is user-supplied.
const command = [
  "pnpm exec prisma migrate diff",
  "--from-migrations ./prisma/migrations",
  // Prisma 7 renamed `--to-schema-datamodel` to `--to-schema`.
  "--to-schema ./prisma/schema.prisma",
  "--exit-code",
].join(" ");

const result = spawnSync(command, { stdio: "inherit", shell: true });

if (result.error) {
  console.error(`\n  Could not run prisma migrate diff: ${result.error.message}\n`);
  process.exit(1);
}

if (result.status === 2) {
  console.error(
    [
      "",
      "  Migration drift detected.",
      "",
      "  schema.prisma contains changes that the committed migrations do not produce.",
      "  Generate a migration instead of pushing:",
      "",
      "      pnpm db:migrate --name <describe_the_change>",
      "",
      "  Never run `prisma db push` against a shared database (CLAUDE.md rule 1).",
      "",
    ].join("\n"),
  );
  process.exit(1);
}

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

console.log("\n  No migration drift: the committed migrations reproduce schema.prisma.\n");
