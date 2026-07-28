import base from "@bam/eslint-config/base";

export default [
  ...base,
  {
    // Fastify's plugin and route registration contract is `async`, whether or
    // not the body awaits anything (FastifyPluginAsync / FastifyPluginAsyncZod).
    // Flagging that is noise, and the obvious "fix" — dropping `async` — changes
    // the return type and breaks registration. Scoped to the files where the
    // framework dictates the shape, rather than switched off repo-wide.
    files: ["src/plugins/**/*.ts", "src/modules/**/*.routes.ts", "src/**/*.test.ts"],
    rules: {
      "@typescript-eslint/require-await": "off",
    },
  },
];
