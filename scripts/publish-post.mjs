/**
 * Pushes a `docs/blog/*.md` post to the portfolio site (my-blog).
 *
 * The Post twin of `publish-user-guide.mjs`, and deliberately simpler: a post
 * carries no screenshots and no cover art, so there is nothing to copy into the
 * portfolio's `public/` — it is one POST to `/api/posts/import`, which upserts
 * the Post row by slug and revalidates `/blog` and `/blog/<slug>`.
 *
 * The markdown file is the single source of truth. Edit it, run this, read the
 * result — never the other way round, and never by pasting into the portfolio's
 * admin form.
 *
 * ## Front matter, and why the H1 is not in the body
 *
 * `/blog/<slug>` renders `post.title` as the page's own `<h1>` and `post.excerpt`
 * as the standfirst beneath it, then the markdown below that. So a body that
 * opens with `# Title` renders the title twice. The title and excerpt live in
 * front matter instead, which is stripped before the content is sent.
 *
 *   ---
 *   slug: two-editors-one-diary        # optional; defaults to the file name
 *   title: Two editors, one diary      # required
 *   excerpt: One sentence for the card and the standfirst.
 *   image: /blog/two-editors/cover.jpg # optional; must already exist on the target
 *   ---
 *
 * ## published
 *
 * Omitting `published` on the wire means "leave it as it is" — the import route
 * treats retracting a live post as a decision that has to be said out loud. This
 * script therefore sends the field only when `--draft` or `--publish` is given,
 * so a plain content correction cannot change a post's visibility by accident.
 * A post that does not exist yet is created as a draft unless `--publish` says
 * otherwise, because a first push is usually one you want to read first.
 *
 * Deliberately plain `.mjs` with no imports beyond node, for the reason the
 * guide script records: the repo root has no runtime dependencies of its own and
 * a publish script is not a reason to give it one.
 *
 * Env (booking-and-more/.env) — shared with `guide:publish`:
 *   PORTFOLIO_API_URL       default http://localhost:3000
 *   PORTFOLIO_IMPORT_SECRET must match my-blog's IMPORT_API_SECRET *on the
 *                           target* — the local and deployed values differ
 *
 * Run: pnpm post:publish docs/blog/two-editors-one-diary.md
 *      pnpm post:publish <file> --dry-run   # show what would be sent, send nothing
 *      pnpm post:publish <file> --publish   # push and make it live
 *      pnpm post:publish <file> --draft     # push and take it back to a draft
 */
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, basename, isAbsolute, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const asDraft = args.includes("--draft");
const asPublished = args.includes("--publish");
const fileArg = args.find((arg) => !arg.startsWith("--"));

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

const API_URL = process.env.PORTFOLIO_API_URL || "http://localhost:3000";
const SECRET = process.env.PORTFOLIO_IMPORT_SECRET;

/**
 * Split `---` front matter from the body.
 *
 * Flat `key: value` only, and that is the whole feature: a post needs four
 * scalars, and a YAML parser would be a dependency bought to read them.
 */
function parseFrontMatter(raw) {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) return { meta: {}, body: raw };

  const meta = {};
  for (const line of match[1].split(/\r?\n/)) {
    const pair = line.match(/^\s*([A-Za-z][\w-]*)\s*:\s*(.*?)\s*$/);
    if (!pair) continue;
    let value = pair[2];
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    meta[pair[1]] = value;
  }

  return { meta, body: raw.slice(match[0].length) };
}

async function main() {
  if (!fileArg) {
    throw new Error(
      "Which post?\n   pnpm post:publish docs/blog/<name>.md [--dry-run|--publish|--draft]",
    );
  }
  if (asDraft && asPublished) {
    throw new Error("--draft and --publish contradict each other; pass one or neither.");
  }
  if (!SECRET) {
    throw new Error(
      "PORTFOLIO_IMPORT_SECRET is not set — add it to booking-and-more/.env.\n" +
        "   It must match IMPORT_API_SECRET on the TARGET site, which for a\n" +
        "   deployed target is not the value in my-blog's local .env.",
    );
  }

  const postPath = isAbsolute(fileArg) ? fileArg : resolve(repoRoot, fileArg);
  if (!existsSync(postPath)) {
    throw new Error(`Missing ${postPath}`);
  }

  const { meta, body } = parseFrontMatter(readFileSync(postPath, "utf8"));
  const content = body.trim();

  const slug = meta.slug || basename(postPath).replace(/\.md$/i, "");
  const title = meta.title;

  if (!title) {
    throw new Error(
      `${fileArg} has no \`title\` in its front matter.\n` +
        "   The site renders the title itself, so it cannot be read off an H1.",
    );
  }
  if (!content) {
    throw new Error(`${fileArg} is empty once its front matter is removed.`);
  }
  // The body would otherwise render its title twice: once from `post.title` in
  // the page's own hero, once from the markdown.
  if (/^#\s/m.test(content.split("\n")[0] ?? "")) {
    throw new Error(
      `${fileArg} still opens with an H1.\n` +
        "   Move it into front matter as `title:` — /blog/<slug> renders the title itself.",
    );
  }

  const payload = { slug, title, content };
  if (meta.excerpt) payload.excerpt = meta.excerpt;
  if (meta.image) payload.image = meta.image;
  // Sent only when asked. See the note on `published` at the top.
  if (asDraft) payload.published = false;
  if (asPublished) payload.published = true;

  const endpoint = `${API_URL.replace(/\/+$/, "")}/api/posts/import`;
  const visibility = asPublished
    ? "true   ← PUBLIC on the target"
    : asDraft
      ? "false  (draft)"
      : "(unchanged — draft if this post is new)";

  console.log(
    `\n→ ${dryRun ? "WOULD POST" : "POST"} ${endpoint}\n` +
      `   file:      ${fileArg}\n` +
      `   slug:      ${slug}\n` +
      `   title:     ${title}\n` +
      `   excerpt:   ${payload.excerpt ? `${payload.excerpt.slice(0, 72)}…` : "(none)"}\n` +
      `   image:     ${payload.image ?? "(none)"}\n` +
      `   content:   ${content.length.toLocaleString()} characters\n` +
      `   published: ${visibility}`,
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
      body: JSON.stringify(payload),
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
      `   ${API_URL.replace(/\/+$/, "")}/blog/${slug}` +
      `${asPublished ? "" : "\n   Not live yet — re-run with --publish when it should be."}`,
  );
}

main().catch((error) => {
  console.error(`❌ Publish failed: ${error.message ?? error}`);
  process.exitCode = 1;
});
