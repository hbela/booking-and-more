import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // No specs yet: the worker gains real logic (and real tests) in Epic 5.
    passWithNoTests: true,
  },
});
