import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.{ts,tsx}"],
    // Unit tests live beside source; Playwright owns browser-level paths.
    passWithNoTests: true,
  },
});
