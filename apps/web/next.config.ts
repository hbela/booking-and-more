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
  poweredByHeader: false,
};

export default withNextIntl(nextConfig);
