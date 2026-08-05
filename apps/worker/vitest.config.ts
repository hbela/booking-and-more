import { defineConfig } from "vitest/config";
import { config as loadDotenv } from "dotenv";

// The dispatcher's integration tests need TEST_DATABASE_URL from the
// repository-root .env, same as @bam/db's.
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
    /**
     * One file at a time, against the one shared test database.
     *
     * `dispatchOutboxBatch` claims across *every* tenant — it is a worker, not
     * a request — so its assertions about how many rows it claimed are global
     * by construction. The dispatcher suite empties the outbox in `beforeEach`
     * to get exclusivity, which works only while nothing else is writing: run
     * concurrently, `stripe.processor.test.ts` inserts its own outbox events
     * mid-batch and the counts come out high.
     *
     * A latent race rather than a new one — it needed only a slower dispatcher
     * file to surface, which docs/phase-9-provider-onboarding.md's tests
     * supplied. Suffixing every id would not help; the claim is deliberately
     * not scoped to a tenant, so the fix has to be that nobody else is writing.
     *
     * `fileParallelism` is only half of it, and the half that was missing cost
     * a red CI: it orders files *within this package*, and `@bam/worker#test`
     * is a turbo task that ran concurrently with `@bam/api#test`. The wipe
     * above does not care which package wrote a row, so it deleted outbox
     * events the API's booking tests had just written and were about to assert
     * on — intermittently, and only where the two happened to overlap. The
     * other half of the exclusivity is the `@bam/worker#test` ordering in
     * turbo.json; neither works without the other.
     */
    fileParallelism: false,
  },
});
