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
};

export default withNextIntl(nextConfig);
