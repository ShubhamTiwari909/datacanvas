/**
 * The write UI keeps nothing: the values a person types or sees, the unlock
 * and the history live in memory only (decisions 125, 129 and 131). This rule
 * fails if the code of `features/writes` or the writes store reaches for
 * browser storage or the console.
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const web = path.resolve(here, "../..");

const files = [
  ...readdirSync(here)
    .filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f))
    .map((f) => path.join(here, f)),
  path.join(web, "stores/writes-store.ts"),
];

/** The code without its comments (a comment may say "never in localStorage"). */
const code = (file: string) =>
  readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

describe("the write UI keeps nothing", () => {
  it("finds the files", () => {
    expect(files.length).toBeGreaterThan(5);
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

  it("applies a change by its preview id only, never by sending the change again", () => {
    const api = code(path.join(here, "api.ts"));
    const apply = api.slice(api.indexOf("export async function requestApply"));
    expect(apply.slice(0, apply.indexOf("\n}\n"))).toMatch(/body: \{ previewId \}/);
  });
});
