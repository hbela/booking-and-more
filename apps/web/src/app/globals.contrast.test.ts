import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Colour contrast, asserted against the stylesheet itself.
 *
 * Two things make this worth a test rather than a review note:
 *
 * 1. **PRD §12.4 commits the product to WCAG 2.1 AA**, and contrast is the one
 *    part of that a machine can check completely. Every text pair needs 4.5:1;
 *    every focus ring and control boundary needs 3:1 (1.4.11).
 * 2. **`globals.css` states the dark palette twice** — once under
 *    `prefers-color-scheme`, once under `[data-theme="dark"]` — because CSS
 *    cannot attach one block to both. That duplication is deliberate and
 *    documented, and it is exactly the kind of thing that drifts silently: a
 *    value corrected in one block and not the other is invisible until a user
 *    with the other setting reports it. Parsing both and comparing them is the
 *    only cheap way to hold them together.
 *
 * It reads the file rather than importing tokens from TypeScript, for the same
 * reason `i18n/routing.test.ts` reads the route directory off disk: the
 * stylesheet is the thing that ships, so the stylesheet is the thing to assert
 * against.
 */

const CSS = readFileSync(fileURLToPath(new URL("./globals.css", import.meta.url)), "utf8");

/** Pull out the body of the first block whose selector line matches. */
function block(startPattern: RegExp): string {
  const start = CSS.search(startPattern);
  expect(start, `no block matching ${String(startPattern)}`).toBeGreaterThan(-1);

  const open = CSS.indexOf("{", start);
  let depth = 0;

  for (let i = open; i < CSS.length; i += 1) {
    if (CSS[i] === "{") depth += 1;
    if (CSS[i] === "}") {
      depth -= 1;
      if (depth === 0) return CSS.slice(open + 1, i);
    }
  }

  throw new Error(`unbalanced braces after ${String(startPattern)}`);
}

/** `--name: value;` pairs, ignoring comments. */
function declarations(source: string): Map<string, string> {
  const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, "");
  const found = new Map<string, string>();

  for (const match of withoutComments.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    const [, name, value] = match;
    if (name !== undefined && value !== undefined) {
      found.set(name, value.trim());
    }
  }

  return found;
}

const theme = declarations(block(/@theme\s*\{/));
const light = declarations(block(/:root,\s*\n?\s*:root\[data-theme="light"\]\s*\{/));
const systemDark = declarations(block(/:root:not\(\[data-theme\]\)\s*\{/));
const chosenDark = declarations(block(/:root\[data-theme="dark"\]\s*\{/));

type Rgb = [number, number, number];

function oklchToRgb(l: number, c: number, hDeg: number): Rgb {
  const h = (hDeg * Math.PI) / 180;
  const a = c * Math.cos(h);
  const b = c * Math.sin(h);

  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.089484177 * a - 1.291485548 * b) ** 3;

  const linear = [
    4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
  ];

  return linear.map((v) => Math.min(1, Math.max(0, v))) as Rgb;
}

/** Resolve a token to linear-light RGB, following `var()` into the ramps. */
function resolve(value: string, scope: Map<string, string>, seen = 0): Rgb {
  if (seen >= 10) throw new Error(`var() chain too deep resolving ${value}`);

  const trimmed = value.trim();

  const variable = /^var\(\s*(--[\w-]+)\s*\)$/.exec(trimmed)?.[1];
  if (variable !== undefined) {
    const next = scope.get(variable) ?? theme.get(variable);
    if (next === undefined) throw new Error(`unresolved ${variable}`);
    return resolve(next, scope, seen + 1);
  }

  const oklch = /^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\)$/.exec(trimmed);
  if (oklch?.[1] !== undefined && oklch[2] !== undefined && oklch[3] !== undefined) {
    return oklchToRgb(Number(oklch[1]), Number(oklch[2]), Number(oklch[3]));
  }

  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(trimmed)?.[1];
  if (hex !== undefined) {
    const digits =
      hex.length === 3
        ? hex
            .split("")
            .map((digit) => digit + digit)
            .join("")
        : hex;

    return [0, 2, 4].map((i) => {
      const channel = parseInt(digits.slice(i, i + 2), 16) / 255;
      return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    }) as Rgb;
  }

  throw new Error(`cannot parse colour: ${trimmed}`);
}

/** A token's value, or a readable failure naming which one is missing. */
function tokenValue(scope: Map<string, string>, name: string): string {
  const value = scope.get(name);
  if (value === undefined) throw new Error(`${name} is not declared in this theme block`);
  return value;
}

function contrast(foreground: Rgb, background: Rgb): number {
  const luminance = (rgb: Rgb): number => 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
  const a = luminance(foreground);
  const b = luminance(background);

  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/**
 * Text pairs need 4.5:1 (WCAG 1.4.3). Ring and control-boundary pairs need
 * 3:1 (1.4.11). Anything not listed here is decorative by decision, not by
 * oversight — `--line` is the only such token, and it draws separators.
 */
const TEXT_PAIRS: [string, string][] = [
  ["--ink", "--surface"],
  ["--ink-muted", "--surface"],
  ["--ink-subtle", "--surface"],
  ["--ink", "--surface-raised"],
  ["--ink-muted", "--surface-raised"],
  ["--ink", "--surface-sunken"],
  ["--ink-muted", "--surface-sunken"],
  ["--on-primary", "--primary"],
  ["--on-primary-surface", "--primary-surface"],
  ["--on-accent", "--accent"],
  ["--on-accent-surface", "--accent-surface"],
  ["--danger", "--surface"],
  ["--success", "--surface"],
  ["--warning", "--surface"],
  ["--danger", "--surface-raised"],
  ["--success", "--surface-raised"],
  ["--warning", "--surface-raised"],
  ["--on-danger-surface", "--danger-surface"],
  ["--on-success-surface", "--success-surface"],
  ["--on-warning-surface", "--warning-surface"],
];

const NON_TEXT_PAIRS: [string, string][] = [
  ["--focus-ring", "--surface"],
  ["--focus-ring", "--surface-raised"],
  ["--line-strong", "--surface"],
  ["--line-strong", "--surface-raised"],
  ["--primary", "--surface"],
  ["--accent", "--surface"],
];

describe.each([
  ["light", light],
  ["dark (system)", systemDark],
  ["dark (chosen)", chosenDark],
])("%s theme", (_name, scope) => {
  it.each(TEXT_PAIRS)("%s on %s reaches 4.5:1", (fg, bg) => {
    expect(
      contrast(resolve(tokenValue(scope, fg), scope), resolve(tokenValue(scope, bg), scope)),
    ).toBeGreaterThanOrEqual(4.5);
  });

  it.each(NON_TEXT_PAIRS)("%s on %s reaches 3:1", (fg, bg) => {
    expect(
      contrast(resolve(tokenValue(scope, fg), scope), resolve(tokenValue(scope, bg), scope)),
    ).toBeGreaterThanOrEqual(3);
  });
});

describe("the two dark blocks", () => {
  // The duplication is deliberate (see globals.css). This is what keeps it
  // honest — without it, a value fixed in one block and not the other is
  // invisible until somebody with the other setting reports it.
  it("declare exactly the same tokens", () => {
    expect([...systemDark.keys()].sort()).toEqual([...chosenDark.keys()].sort());
  });

  it("declare exactly the same values", () => {
    for (const [name, value] of systemDark) {
      expect(chosenDark.get(name), `${name} differs between the two dark blocks`).toBe(value);
    }
  });
});

describe("the light block", () => {
  it("declares every token the dark blocks do", () => {
    expect([...light.keys()].sort()).toEqual([...systemDark.keys()].sort());
  });

  // brand-500 is 3.95:1 on white. It reads as a usable link colour and is not,
  // so the stylesheet must never hand it to a text token.
  it("never uses brand-500 or accent-500 for a text token", () => {
    for (const [fg] of TEXT_PAIRS) {
      expect(light.get(fg)).not.toMatch(/--(?:color-)?(?:brand|accent)-500/);
    }
  });
});
