/**
 * Vitest configuration (unit and integration tests, run from the repo root).
 * Playwright end-to-end tests arrive in Phase 12 and are separate.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    // Mirror the "@/..." path alias that apps/web/tsconfig.json defines.
    alias: [{ find: /^@\//, replacement: `${path.join(root, "apps/web")}/` }],
  },
  test: {
    environment: "node",
    include: ["apps/**/*.test.ts", "packages/**/*.test.ts", "tests/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", "**/.next/**", "**/.package/**"],
  },
});
