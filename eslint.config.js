// ESLint "flat config" (the current format). Applies to every workspace.
//
// Division of labour: ESLint finds likely bugs and bad patterns;
// Prettier owns formatting. `eslint-config-prettier` (last in the list)
// switches off any ESLint rule that would fight Prettier over style.
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  {
    ignores: ["**/dist/**", "**/node_modules/**", "**/.next/**", "**/coverage/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // The plan forbids `any`: untrusted input must go through Zod instead.
      "@typescript-eslint/no-explicit-any": "error",
      // Pairs with `verbatimModuleSyntax` in tsconfig.base.json.
      "@typescript-eslint/consistent-type-imports": "error",
      // Allow intentionally-unused names when prefixed with an underscore.
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
  prettier,
);
