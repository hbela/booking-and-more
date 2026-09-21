import { withSentryConfig } from "@sentry/nextjs/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

// fileURLToPath, not URL.pathname: on Windows the latter yields "/C:/..." with
// a leading slash, which Turbopack rejects as escaping the project path.
const appDir = path.dirname(fileURLToPath(import.meta.url));

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Self-contained server bundle for the Docker image (docker/Dockerfile.web).
  output: "standalone",
  // The monorepo root, so tracing picks up linked workspace packages.
  outputFileTracingRoot: path.resolve(appDir, "../.."),
  // Next 16.3.1's file tracer follows @swc/helpers' CommonJS conditional
  // export but can omit its ESM sibling. Node 24 resolves that ESM file while
  // booting the standalone server, so an otherwise successful image enters a
  // restart loop with MODULE_NOT_FOUND. Force the narrowly scoped runtime
  // files into every server trace; paths are relative to this Next.js app.
  outputFileTracingIncludes: {
    "/*": ["../../node_modules/.pnpm/@swc+helpers@*/node_modules/@swc/helpers/esm/**/*"],
  },
  poweredByHeader: false,
  headers() {
    return Promise.resolve([
      {
        source: "/sw.js",
        headers: [
          { key: "Content-Type", value: "application/javascript; charset=utf-8" },
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
          {
            key: "Content-Security-Policy",
            value: "default-src 'self'; script-src 'self'; object-src 'none'",
          },
          { key: "X-Content-Type-Options", value: "nosniff" },
        ],
      },
      {
        source: "/pwa/:path*",
        headers: [
          {
            key: "Content-Security-Policy",
            value:
              "default-src 'none'; style-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
          },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "no-referrer" },
        ],
      },
    ]);
  },
};

export default withSentryConfig(withNextIntl(nextConfig), {
  ...(process.env.SENTRY_ORG ? { org: process.env.SENTRY_ORG } : {}),
  ...(process.env.SENTRY_PROJECT ? { project: process.env.SENTRY_PROJECT } : {}),
  ...(process.env.SENTRY_AUTH_TOKEN ? { authToken: process.env.SENTRY_AUTH_TOKEN } : {}),
  silent: !process.env.CI,
  widenClientFileUpload: true,
  tunnelRoute: "/api/monitoring",
  sourcemaps: {
    disable: !process.env.SENTRY_AUTH_TOKEN,
    deleteSourcemapsAfterUpload: true,
  },
});
