/**
 * Security rules, enforced as tests so they cannot be broken quietly.
 *
 *  1. Every API route handler is guarded (Host / Origin / session token).
 *  2. There is never an arbitrary-SQL endpoint.
 *  3. No code sends CORS headers (other sites must not read our responses).
 *  4. The CLI never binds beyond loopback.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.name === "node_modules" || entry.name === ".next") return [];
    return entry.isDirectory() ? walk(full) : [full];
  });
}

const apiDir = path.join(root, "apps/web/app/api");
const routeFiles = walk(apiDir).filter((f) => f.endsWith(`${path.sep}route.ts`));
const rel = (file: string) => path.relative(root, file);

describe("API routes are guarded", () => {
  it("finds the route files", () => {
    expect(routeFiles.length).toBeGreaterThan(10);
  });

  it.each(routeFiles.map((f) => [rel(f), f]))("%s runs the guard", (_name, file) => {
    const code = readFileSync(file as string, "utf8");
    if (code.includes("notFound")) return; // the JSON 404 catch-all touches no data
    // handleRoute(request, ...) re-checks Host, Origin and token; health calls guardRequest.
    expect(code).toMatch(/handleRoute\(\s*request\b|guardRequest\(\s*request\b/);
  });

  it("has proxy.ts in front of every route", () => {
    const proxy = readFileSync(path.join(root, "apps/web/proxy.ts"), "utf8");
    expect(proxy).toContain("evaluateRequest");
  });
});

describe("no arbitrary SQL, ever", () => {
  it("has no route whose path suggests running SQL", () => {
    for (const file of routeFiles) {
      expect(rel(file).toLowerCase(), rel(file)).not.toMatch(/\b(sql|query|exec|execute|raw)\b/);
    }
  });
});

describe("no CORS", () => {
  it("never sets Access-Control-* headers in app code", () => {
    const files = walk(path.join(root, "apps/web")).filter(
      (f) => /\.(ts|tsx|mjs)$/.test(f) && !f.endsWith(".test.ts") && !f.includes("node_modules"),
    );
    for (const file of files) {
      expect(readFileSync(file, "utf8").toLowerCase(), rel(file)).not.toContain(
        "access-control-allow",
      );
    }
  });
});

describe("loopback only", () => {
  it("the CLI never mentions an all-interfaces address", () => {
    const files = walk(path.join(root, "packages/cli/src")).filter((f) => f.endsWith(".ts"));
    for (const file of files) {
      if (file.endsWith(".test.ts")) continue;
      const code = readFileSync(file, "utf8");
      // Comments may warn about it; code must not use it.
      const withoutComments = code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      expect(withoutComments, rel(file)).not.toContain("0.0.0.0");
    }
  });
});
