import base from "@bam/eslint-config/base";

export default [
  { ignores: ["src/generated/**", "prisma/migrations/**"] },
  ...base,
  {
    // prisma.config.ts is read by the Prisma CLI only and is never bundled into
    // the application, so it cannot import @bam/config — that package is built
    // by the same pipeline the CLI is needed to run. Reading process.env here is
    // the documented exception to CLAUDE.md rule 3.
    files: ["prisma.config.ts"],
    rules: {
      "no-restricted-properties": "off",
      "@typescript-eslint/no-unsafe-call": "off",
    },
  },
];
