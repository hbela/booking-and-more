import { defineConfig } from "vitest/config";

export default defineConfig({
  oxc: { jsx: { runtime: "automatic" } },
  test: {
    // Bundle next-intl so Vite resolves its Next.js extensionless imports when
    // exercising the real locale middleware outside the Next.js runtime.
    server: { deps: { inline: ["next-intl"] } },
    include: ["src/**/*.test.{ts,tsx}"],
    // Unit tests live beside source; Playwright owns browser-level paths.
    passWithNoTests: true,
  },
});
