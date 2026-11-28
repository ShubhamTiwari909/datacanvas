/**
 * The SQL view uses no browser storage (decision 141): a statement can hold literals and personal data,
 * and a result is rows. Explicit library saves go through the protected local API. This
 * rule fails if the code of `features/sql` or the SQL store reaches for browser storage or the
 * console, or calls the network other than through `api.ts`.
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const web = path.resolve(here, "../..");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

const files = [...sourceFiles(here), path.join(web, "stores/sql-store.ts")];

/**
 * The code without its comments. Strings and template texts are skipped over first, so a `//` or a
 * `/*` inside one (a URL, a glob) is not taken for a comment that hides what follows.
 */
const code = (file: string) =>
  readFileSync(file, "utf8").replace(
    /("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g,
    (_match, literal: string | undefined) => literal ?? "",
  );

describe("the SQL view uses no browser storage", () => {
  it("reads code the way a compiler does: a comment marker inside a string hides nothing", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "sql-privacy-"));
    try {
      const file = path.join(dir, "x.ts");
      writeFileSync(
        file,
        'const url = "http://x"; localStorage.setItem("a", "b"); // note\nconst g = `a//b`;',
      );
      expect(code(file)).toContain("localStorage");
      writeFileSync(file, "// localStorage.setItem()\n/* sessionStorage */ const a = 1;");
      expect(code(file)).not.toContain("localStorage");
      expect(code(file)).not.toContain("sessionStorage");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("finds the files", () => {
    expect(files.length).toBeGreaterThan(5);
    expect(files.map((f) => path.basename(f))).toEqual(
      expect.arrayContaining(["api.ts", "sql-view.tsx", "sql-store.ts", "sql-editor.tsx"]),
    );
  });

  it.each([
    "localStorage",
    "sessionStorage",
    "indexedDB",
    "document.cookie",
    "caches.",
    "persist(",
    "console.",
    "navigator.sendBeacon",
    "BroadcastChannel",
  ])("never touches %s", (api) => {
    for (const file of files) expect(code(file), path.relative(web, file)).not.toContain(api);
  });

  it("calls the network only in api.ts, and loads nothing from another host", () => {
    for (const file of files) {
      const source = code(file);
      if (file !== path.join(here, "api.ts")) {
        expect(source, path.relative(web, file)).not.toMatch(/\bfetch\(|XMLHttpRequest|WebSocket/);
      }
      expect(source, path.relative(web, file)).not.toMatch(/https?:\/\//);
    }
  });
});
