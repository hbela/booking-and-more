import { fileURLToPath } from "node:url";
import path from "node:path";
import { config as loadDotenv } from "dotenv";
import { defineConfig } from "@prisma/config";

// The repository keeps a single .env at the root. Prisma resolves this config
// relative to packages/db, so point dotenv at the root explicitly rather than
// relying on cwd.
const packageRoot = path.dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: path.resolve(packageRoot, "../../.env"), override: false, quiet: true });

/**
 * Prisma CLI configuration.
 *
 * Prisma 7 removed `url` from the datasource block in schema.prisma. The CLI
 * (migrate, studio, db pull) reads its connection from here; the runtime client
 * gets its own connection through a driver adapter in src/index.ts.
 *
 * This file is read by the CLI only — it is never bundled into the application,
 * so reading process.env here does not violate CLAUDE.md rule 3.
 */

const databaseUrl = process.env["DATABASE_URL"];

if (!databaseUrl) {
  throw new Error(
    "DATABASE_URL is not set. Copy .env.example to .env at the repository root, or export it before running a Prisma command.",
  );
}

/**
 * `migrate dev` and `migrate diff` need a scratch database to materialise
 * migrations into. Derive one from DATABASE_URL so a fresh clone works without
 * extra configuration.
 */
const shadowDatabaseUrl =
  process.env["SHADOW_DATABASE_URL"] ??
  (() => {
    const url = new URL(databaseUrl);
    url.pathname = "/booking_and_more_shadow";
    return url.toString();
  })();

export default defineConfig({
  schema: "./prisma/schema.prisma",
  migrations: {
    path: "./prisma/migrations",
    seed: "tsx ./prisma/seed.ts",
  },
  datasource: {
    url: databaseUrl,
    shadowDatabaseUrl,
  },
});
