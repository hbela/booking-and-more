import { defineConfig } from "@playwright/test";
import live from "./playwright.live.config";

export default defineConfig(live, {
  testMatch: "**/stripe-sandbox.spec.ts",
  testIgnore: [],
  timeout: 600_000,
  outputDir: "./test-results/stripe-live",
});
