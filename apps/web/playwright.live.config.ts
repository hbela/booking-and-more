import { defineConfig, devices } from "@playwright/test";

/** Real staging traffic. Deliberately separate from the mocked e2e directory. */
export default defineConfig({
  testDir: "./e2e-live",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  maxFailures: 1,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: "list",
  outputDir: "./test-results/live",
  use: {
    baseURL: "https://app.booking.appointer.hu",
    locale: "en-GB",
    timezoneId: "Europe/Budapest",
    // Network traces contain booking management and conversation credentials.
    trace: "off",
    screenshot: "off",
    video: "off",
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
