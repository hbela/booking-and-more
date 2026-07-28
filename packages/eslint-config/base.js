import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

/**
 * Shared flat config for every TypeScript workspace.
 *
 * Two rules here exist to enforce conventions from CLAUDE.md rather than
 * general style, and are worth not weakening:
 *
 *   - `no-restricted-syntax` on `req.body as any` (rule 2, schema-first routes)
 *   - `no-restricted-properties` on `process.env` (rule 3, env parsed at the edge)
 */
export const base = tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/.next/**",
      "**/node_modules/**",
      "**/generated/**",
      // Plain-JS build and ops scripts. Type-aware linting needs a TS project,
      // and adding one for a handful of .mjs files is not worth the ceremony.
      "**/*.js",
      "**/*.mjs",
      "**/*.cjs",
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        projectService: true,
      },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "inline-type-imports" },
      ],
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/require-await": "error",

      // CLAUDE.md rule 2 — schema-first routes.
      // Casting a request member to `any` bypasses the Zod type provider, which
      // takes runtime validation, response serialization and the OpenAPI spec
      // down with it. This is exactly how the predecessor project ended up with
      // a 240 KB openapi.json that described nothing.
      "no-restricted-syntax": [
        "error",
        {
          selector:
            'TSAsExpression[typeAnnotation.type="TSAnyKeyword"][expression.type="MemberExpression"][expression.property.name=/^(body|query|querystring|params|headers)$/]',
          message:
            "Do not cast request members to `any`. Declare a Zod `schema` on the route and let fastify-type-provider-zod infer the type (CLAUDE.md rule 2).",
        },
      ],

      // CLAUDE.md rule 3 — environment is parsed once, at the edge.
      // Overridden in packages/config, which is the one place allowed to read it.
      "no-restricted-properties": [
        "error",
        {
          object: "process",
          property: "env",
          message:
            "Import validated config from @bam/config instead of reading process.env directly (CLAUDE.md rule 3).",
        },
      ],

      eqeqeq: ["error", "always", { null: "ignore" }],
      "no-console": ["warn", { allow: ["warn", "error"] }],
    },
  },

  // Tests get a little slack: fixtures legitimately need loose casts, and
  // asserting on rejected promises reads better without the promise rules.
  {
    files: ["**/*.test.ts", "**/*.spec.ts", "**/tests/**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "no-restricted-properties": "off",
    },
  },

  prettier,
);

export default base;
