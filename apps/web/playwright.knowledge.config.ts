import { defineConfig, devices } from "@playwright/test";

/** Mocked owner UI checks against an already-running local development server. */
export default defineConfig({
  testDir: "./e2e",
  testMatch: "knowledge-budget.spec.ts",
  workers: 1,
  timeout: 60_000,
  use: { baseURL: "http://localhost:3000", trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
