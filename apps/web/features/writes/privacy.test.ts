/**
 * The write UI keeps nothing: the values a person types or sees, the unlock
 * and the history live in memory only (decisions 125, 129 and 131). This rule
 * fails if the code of `features/writes` or the writes store reaches for
 * browser storage or the console.
 */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const web = path.resolve(here, "../..");

/** Every source file under a folder, at any depth (a component in a subfolder is covered too). */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

const files = [...sourceFiles(here), path.join(web, "stores/writes-store.ts")];

/** The code without its comments (a comment may say "never in localStorage"). */
const code = (file: string) =>
  readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

describe("the write UI keeps nothing", () => {
  it("finds the files, including those in subfolders", () => {
    expect(files.length).toBeGreaterThan(5);
    expect(sourceFiles(here)).toContain(path.join(here, "api.ts"));
  });

  it("walks into subfolders", () => {
    const root = mkdtempSync(path.join(tmpdir(), "writes-privacy-"));
    try {
      mkdirSync(path.join(root, "deep/er"), { recursive: true });
      writeFileSync(path.join(root, "top.ts"), "");
      writeFileSync(path.join(root, "deep/er/nested.tsx"), "");
      writeFileSync(path.join(root, "deep/er/nested.test.tsx"), "");
      expect(
        sourceFiles(root)
          .map((f) => path.relative(root, f))
          .sort(),
      ).toEqual([path.join("deep", "er", "nested.tsx"), "top.ts"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    "localStorage",
    "sessionStorage",
    "indexedDB",
    "document.cookie",
    "caches.",
    "persist(",
    "console.",
  ])("never touches %s", (api) => {
    for (const file of files) expect(code(file), path.relative(web, file)).not.toContain(api);
  });

  it("applies a change by its preview id only (and the count typed), never by sending the change again", () => {
    const api = code(path.join(here, "api.ts"));
    const apply = api.slice(api.indexOf("export async function requestApply"));
    expect(apply.slice(0, apply.indexOf("\n}\n"))).toMatch(/body: \{ previewId, confirmRows \}/);
  });
});
