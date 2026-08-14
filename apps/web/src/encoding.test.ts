import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * No source file may start with a UTF-8 byte-order mark.
 *
 * `locations-screen.tsx` carried one. Nothing failed loudly — TypeScript and
 * the bundler both tolerate it — but a BOM is a real character at offset 0, so
 * every tool that reads the file without `utf-8-sig` sees U+FEFF glued to the
 * first `import`. That is how it was originally mis-reported as mojibake in the
 * file's em dashes, which were in fact fine: the corruption was in the reading,
 * not the file. A defect that makes other tools lie about your source is worth
 * one assertion.
 *
 * It is written as a walk rather than a glob so it needs no extra dependency,
 * and it covers every extension rather than a list somebody has to remember to
 * extend.
 */
const SRC = fileURLToPath(new URL(".", import.meta.url));
const SKIP = new Set(["node_modules", ".next", "dist"]);

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);

    if (entry.isDirectory()) {
      return SKIP.has(entry.name) ? [] : sourceFiles(path);
    }

    return /\.(ts|tsx|css|json)$/.test(entry.name) ? [path] : [];
  });
}

describe("source encoding", () => {
  const files = sourceFiles(SRC);

  it("finds files to check", () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it("has no byte-order marks", () => {
    const withBom = files.filter((path) => readFileSync(path, "utf8").charCodeAt(0) === 0xfeff);

    expect(withBom.map((path) => path.slice(SRC.length))).toEqual([]);
  });
});
