import tseslint from "typescript-eslint";
import { base } from "./base.js";

/**
 * Next.js flavour of the shared config.
 *
 * `process.env` is permitted here: Next inlines NEXT_PUBLIC_* at build time, so
 * routing it through @bam/config (a Node-only package) would break the client
 * bundle. Server-side code in apps/web should still prefer @bam/config.
 */
export const next = tseslint.config(...base, {
  files: ["**/*.ts", "**/*.tsx"],
  rules: {
    "no-restricted-properties": "off",
  },
});

export default next;
