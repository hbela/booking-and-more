import { defineConfig } from "vitest/config";
import { config as loadDotenv } from "dotenv";

// Integration tests need TEST_DATABASE_URL from the repository-root .env.
loadDotenv({
  path: new URL("../../.env", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
  override: false,
  quiet: true,
});

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
