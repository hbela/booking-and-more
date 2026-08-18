/**
 * Pushes docs/user-guide.md to the portfolio site (my-blog).
 *
 *   1. Copies the cover image, and any `assets/screenshots/*` the guide
 *      references, into the portfolio's `public/<slug>/` directory. Both repos
 *      are local; commit those files in my-blog and redeploy it to ship them.
 *   2. POSTs the manifest + markdown to the portfolio's import API, which
 *      upserts the Project row and revalidates its pages.
 *
 * The guide is the single source of truth. Edit `docs/user-guide.md`, run this,
 * read the result — never the other way round, and never by pasting into the
 * portfolio's admin form.
 *
 * Deliberately plain `.mjs` with no imports beyond node: the repo root has no
 * runtime dependencies of its own, and a publish script is not a reason to give
 * it one. Rule 3 (`@bam/config` owns env) governs the apps; this is a standalone
 * script, like the `db:*` ones.
 *
 * Env (booking-and-more/.env):
 *   PORTFOLIO_API_URL       default http://localhost:3000
 *   PORTFOLIO_IMPORT_SECRET must match my-blog's IMPORT_API_SECRET *on the
 *                           target* — the local and deployed values differ
 *   PORTFOLIO_PUBLIC_DIR    default ../my-blog/public
 *
 * Run: pnpm guide:publish            # push, leave published as the manifest says
 *      pnpm guide:publish --dry-run  # show what would be sent, send nothing
 *      pnpm guide:publish --draft    # push as a draft instead of live
 */
import { readFileSync, copyFileSync, mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, isAbsolute, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const asDraft = args.includes("--draft");

// --- Minimal .env loader (no dotenv at the repo root) ----------------------
function loadEnv() {
  const envPath = join(repoRoot, ".env");
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i);
    if (!match) continue;
    const key = match[1];
    let value = match[2];
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
loadEnv();

const SLUG = "booking-and-more";
const API_URL = process.env.PORTFOLIO_API_URL || "http://localhost:3000";
const SECRET = process.env.PORTFOLIO_IMPORT_SECRET;
const PUBLIC_DIR = process.env.PORTFOLIO_PUBLIC_DIR || "../my-blog/public";

/**
 * `docTheme: true` is what earns the sidebar, the numbered sections and the
 * mermaid rendering. Without it the guide renders as a plain project page and
 * the diagrams stay as code blocks.
 */
const manifest = {
  slug: SLUG,
  title: "booking-and-more",
  brandIcon: "B",
  docTheme: true,
  published: !asDraft,
  technologies: "Next.js, Fastify, PostgreSQL, Prisma, BullMQ, Stripe, Better Auth, TypeScript",
  excerpt:
    "A multi-tenant appointment-booking platform for clinics, salons and studios: a public booking page customers use without an account, and a staff dashboard for services, providers, working hours and the day's appointments — with each business kept entirely separate from every other.",
  image: `/${SLUG}/cover.jpg`,
};

/** Cover art and any other fixed assets, as [source, destination name]. */
const ASSETS = [["apps/web/public/hero-booking.jpg", "cover.jpg"]];

async function main() {
  if (!SECRET) {
    throw new Error(
      "PORTFOLIO_IMPORT_SECRET is not set — add it to booking-and-more/.env.\n" +
        "   It must match IMPORT_API_SECRET on the TARGET site, which for a\n" +
        "   deployed target is not the value in my-blog's local .env.",
    );
  }

  const guidePath = join(repoRoot, "docs", "user-guide.md");
  if (!existsSync(guidePath)) {
    throw new Error(`Missing ${guidePath}`);
  }
  const content = readFileSync(guidePath, "utf8");

  const publicDir = isAbsolute(PUBLIC_DIR) ? PUBLIC_DIR : resolve(repoRoot, PUBLIC_DIR);
  if (!existsSync(publicDir)) {
    throw new Error(
      `Portfolio public directory not found: ${publicDir}\n` +
        "   Set PORTFOLIO_PUBLIC_DIR if my-blog lives somewhere else.",
    );
  }
  const destDir = join(publicDir, SLUG);

  // 1. Copy fixed assets, plus every screenshot the guide references.
  const copied = [];
  const missing = [];

  mkdirSync(destDir, { recursive: true });

  for (const [source, destName] of ASSETS) {
    const from = join(repoRoot, source);
    if (!existsSync(from)) {
      missing.push(source);
      continue;
    }
    copyFileSync(from, join(destDir, destName));
    copied.push(destName);
  }

  // The import API rewrites `assets/screenshots/x.png` to `/<slug>/x.png`, so
  // whatever the guide references has to land in the portfolio's public dir
  // under the same name.
  const referenced = new Set();
  for (const match of content.matchAll(/assets\/screenshots\/([\w.-]+)/g)) {
    referenced.add(match[1]);
  }
  for (const name of referenced) {
    const from = join(repoRoot, "docs", "assets", "screenshots", name);
    if (!existsSync(from)) {
      missing.push(`docs/assets/screenshots/${name}`);
      continue;
    }
    copyFileSync(from, join(destDir, name));
    copied.push(name);
  }

  if (missing.length) {
    throw new Error(`Missing asset(s):\n   ${missing.join("\n   ")}`);
  }
  console.log(`✅ Copied ${copied.length} asset(s) → ${destDir}\n   ${copied.join(", ")}`);

  // 2. POST to the import API.
  const endpoint = `${API_URL.replace(/\/+$/, "")}/api/projects/import`;

  console.log(
    `\n→ ${dryRun ? "WOULD POST" : "POST"} ${endpoint}\n` +
      `   slug:      ${manifest.slug}\n` +
      `   title:     ${manifest.title}\n` +
      `   image:     ${manifest.image}\n` +
      `   content:   ${content.length.toLocaleString()} characters\n` +
      `   docTheme:  ${manifest.docTheme}\n` +
      `   published: ${manifest.published}${manifest.published ? "  ← PUBLIC on the target" : "  (draft)"}`,
  );

  if (dryRun) {
    console.log("\n✋ --dry-run: nothing sent.");
    return;
  }

  let response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${SECRET}`,
      },
      body: JSON.stringify({ ...manifest, content }),
    });
  } catch (error) {
    throw new Error(
      `Could not reach ${endpoint}\n   ${error.message}\n` +
        "   Is the portfolio running? (cd ../my-blog && pnpm dev)",
    );
  }

  const text = await response.text();
  if (!response.ok) {
    // 401 almost always means the secrets have drifted rather than that the
    // endpoint is broken — name it, so nobody debugs the route instead.
    const hint =
      response.status === 401
        ? "\n   401 — PORTFOLIO_IMPORT_SECRET does not match the target's IMPORT_API_SECRET."
        : "";
    throw new Error(`${endpoint} returned ${response.status}\n   ${text}${hint}`);
  }

  const result = JSON.parse(text);
  console.log(
    `\n✅ ${result.action === "created" ? "Created" : "Updated"} on ${API_URL}\n` +
      `   ${API_URL.replace(/\/+$/, "")}/projects/${SLUG}` +
      `${manifest.published ? "" : "   (draft — not publicly visible)"}`,
  );
}

main().catch((error) => {
  console.error(`❌ Publish failed: ${error.message ?? error}`);
  process.exitCode = 1;
});
