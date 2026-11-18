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

describe("canvas-engine stays framework-free", () => {
  const engineDir = path.join(root, "packages/canvas-engine");

  it("depends only on database-core", () => {
    const pkg = JSON.parse(readFileSync(path.join(engineDir, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    expect(Object.keys(pkg.dependencies ?? {})).toEqual(["@datacanvas/database-core"]);
  });

  it("imports only relative modules, database-core, and vitest in tests (no React, no canvas library)", () => {
    const files = sourceFiles(path.join(engineDir, "src"));
    expect(files.length).toBeGreaterThan(5);

    for (const file of files) {
      const isTest = file.endsWith(".test.ts");
      for (const specifier of importSpecifiers(readFileSync(file, "utf8"))) {
        const allowed =
          specifier.startsWith(".") ||
          specifier === "@datacanvas/database-core" ||
          (isTest && specifier === "vitest");
        expect(allowed, `${path.relative(root, file)} imports "${specifier}"`).toBe(true);
      }
    }
  });
});

describe("writes are a separate capability (1.4.0)", () => {
  // Line endings are normalised first: a CRLF checkout (Windows) must read the same as an LF one.
  const strip = (text: string) =>
    text
      .replace(/\r\n/g, "\n")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
  // Paths are written with `/` in the rules, whatever the platform's separator is.
  const posix = (file: string) => file.split(path.sep).join("/");
  const adapterSource = strip(readFileSync(path.join(coreDir, "src/adapter.ts"), "utf8"));
  const inBody = (source: string, header: string): string => {
    const start = source.indexOf(header);
    expect(start, header).toBeGreaterThan(-1);
    return source.slice(start, source.indexOf("\n}\n", start));
  };

  it("DatabaseAdapter has no method that changes anything", () => {
    const readOnly = inBody(adapterSource, "export interface DatabaseAdapter");
    expect(readOnly).not.toMatch(/\b(applyChange|previewChange|describeForEdit)\b/);
    // The one addition for 1.4.0 reads the role's rights from the catalog.
    expect(readOnly).toContain("getRoleInfo()");
  });

  it("WritableAdapter takes a structured Change or a plan: no SQL text in any signature", () => {
    const writable = inBody(adapterSource, "export interface WritableAdapter");
    expect(writable).toMatch(/previewChange\(change: Change\)/);
    expect(writable).toMatch(/applyChange\(plan: PlannedChange\)/);
    expect(writable).not.toMatch(/\b(sql|statement|query|text)\s*:\s*string/i);
  });

  it("only an adapter implements it: the mock and the PostgreSQL adapter", () => {
    const implementers = [
      ...sourceFiles(path.join(root, "packages")),
      ...sourceFiles(path.join(root, "apps/web")),
    ].filter(
      (file) =>
        !file.endsWith(".test.ts") &&
        !file.endsWith(".d.ts") &&
        !file.includes("node_modules") &&
        !file.includes(`${path.sep}dist${path.sep}`) &&
        /\bimplements\b[^{]*\bWritableAdapter\b/.test(strip(readFileSync(file, "utf8"))),
    );
    for (const file of implementers) {
      expect(
        /testing\/mock-adapter\.ts$|postgres-adapter\/src\/.*\.ts$/.test(posix(file)),
        posix(path.relative(root, file)),
      ).toBe(true);
    }
    expect(implementers.some((f) => posix(f).endsWith("testing/mock-adapter.ts"))).toBe(true);
  });

  it("the web app's server code imports the write capability in one file only", () => {
    const users = sourceFiles(path.join(root, "apps/web"))
      .filter((f) => !f.endsWith(".test.ts") && !f.includes("node_modules") && !f.includes(".next"))
      .filter((f) => /\b(WritableAdapter|isWritableAdapter)\b/.test(strip(readFileSync(f, "utf8"))))
      .map((f) => posix(path.relative(root, f)));
    expect(users).toEqual(["apps/web/lib/server/write-service.ts"]);
  });

  it("database-core's change types stay free of drivers and frameworks", () => {
    const source = readFileSync(path.join(coreDir, "src/changes.ts"), "utf8");
    for (const specifier of importSpecifiers(source)) {
      expect(specifier.startsWith("."), specifier).toBe(true);
    }
  });
});
