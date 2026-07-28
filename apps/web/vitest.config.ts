import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.{ts,tsx}"],
    // No specs yet. The web app gains component tests alongside the booking
    // flow in Epic 4; Playwright owns the end-to-end paths (tech-impl §39.6).
    passWithNoTests: true,
  },
});
