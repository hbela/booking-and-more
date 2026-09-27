import { defineConfig, devices } from "@playwright/test";

/** Isolated UI verification: every chat API request is mocked by the tests. */
export default defineConfig({
  testDir: "./e2e",
  testMatch: "chat-guardrails.spec.ts",
  workers: 1,
  timeout: 60_000,
  use: { baseURL: "http://localhost:3110", trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "pnpm exec next dev --port 3110",
    url: "http://localhost:3110/en/guardrail-test/chat",
    timeout: 120_000,
    env: { NEXT_PUBLIC_API_BASE_URL: "http://127.0.0.1:3111" },
  },
});
