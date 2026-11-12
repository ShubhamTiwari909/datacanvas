/**
 * Architecture rules, enforced as tests so they cannot be broken quietly.
 *
 * Rule: `database-core` must stay independent. It may not depend on any
 * package, and its source may not import a database driver, Next.js or React.
 * Only relative imports are allowed (plus `vitest` in test files and in
 * `testing/contract.ts`, the shared contract test suite).
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const coreDir = path.join(root, "packages/database-core");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return full.endsWith(".ts") ? [full] : [];
  });
}

/** Module specifiers used by import/export-from statements and dynamic imports. */
function importSpecifiers(code: string): string[] {
  const pattern = /(?:from\s+|import\s*\(\s*|import\s+)["']([^"']+)["']/g;
  return [...code.matchAll(pattern)].map((match) => match[1] as string);
}

describe("database-core stays independent", () => {
  it("declares no dependencies of any kind", () => {
    const pkg = JSON.parse(readFileSync(path.join(coreDir, "package.json"), "utf8")) as Record<
      string,
      unknown
    >;
    for (const field of ["dependencies", "peerDependencies", "optionalDependencies"]) {
      expect(pkg[field] ?? {}, field).toEqual({});
    }
  });

  it("imports only relative modules (and vitest inside test code)", () => {
    const files = sourceFiles(path.join(coreDir, "src"));
    expect(files.length).toBeGreaterThan(5);

    for (const file of files) {
      // `vitest` is allowed only in code that exists to run tests.
      const isTest = file.endsWith(".test.ts") || file.endsWith("testing/contract.ts");
      for (const specifier of importSpecifiers(readFileSync(file, "utf8"))) {
        const allowed = specifier.startsWith(".") || (isTest && specifier === "vitest");
        expect(allowed, `${path.relative(root, file)} imports "${specifier}"`).toBe(true);
      }
    }
  });
});
