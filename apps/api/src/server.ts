// Must be first: Sentry patches the modules imported after it.
import { env } from "./instrument.js";
import { flushSentry } from "@bam/observability";
import { buildApp } from "./app.js";

async function main(): Promise<void> {
  const app = await buildApp({ env });

  // Drain in-flight requests before exiting so a deploy does not sever an
  // in-progress booking confirmation.
  const shutdown = (signal: string) => {
    app.log.info({ signal }, "shutting down");

    void (async () => {
      try {
        await app.close();
        await flushSentry();
        process.exit(0);
      } catch (error) {
        app.log.error({ err: error }, "error during shutdown");
        process.exit(1);
      }
    })();
  };

  process.on("SIGTERM", () => {
    shutdown("SIGTERM");
  });
  process.on("SIGINT", () => {
    shutdown("SIGINT");
  });

  await app.listen({ port: env.PORT, host: "0.0.0.0" });

  app.log.info(
    {
      port: env.PORT,
      docs: env.NODE_ENV === "production" ? undefined : `${env.API_BASE_URL}/docs`,
    },
    "api listening",
  );
}

main().catch((error: unknown) => {
  // The logger may not exist yet if buildApp itself threw.
  console.error("Failed to start the API:", error);
  process.exit(1);
});
