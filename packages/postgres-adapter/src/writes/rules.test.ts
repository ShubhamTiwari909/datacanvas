/**
 * Rules the write path is held to, checked on its SOURCE so they cannot be
 * broken by a statement no test happens to build (decisions 130, 132, 133):
 * no CASCADE on a drop, no CONCURRENTLY, no USING expression, no check
 * constraint, and no logging of anything.
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));

/** Source of every non-test file of the write path, with comments removed. */
function sources(): Array<{ file: string; code: string }> {
  const files = [
    ...readdirSync(here)
      .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
      .map((name) => path.join(here, name)),
    path.join(here, "../connection/write.ts"),
    path.join(here, "../connection/write-errors.ts"),
  ];
  return files.map((file) => ({
    file: path.basename(file),
    code: readFileSync(file, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, ""),
  }));
}

describe("write path source rules", () => {
  const all = sources();

  it("covers the files of the write path", () => {
    expect(all.map((s) => s.file).sort()).toEqual([
      "catalog.ts",
      "guard.ts",
      "index.ts",
      "keyed.ts",
      "rows.ts",
      "sql.ts",
      "structure.ts",
      "write-errors.ts",
      "write.ts",
    ]);
  });

  it("CASCADE exists only as a foreign key's referential action", () => {
    for (const { file, code } of all) {
      const lines = code.split("\n").filter((line) => /CASCADE/.test(line));
      if (file === "sql.ts") {
        expect(lines.map((l) => l.trim())).toEqual(['cascade: "CASCADE",']);
      } else {
        expect([file, lines]).toEqual([file, []]);
      }
    }
  });

  it("no drop statement can carry anything after the name", () => {
    const structure = all.find((s) => s.file === "structure.ts")!.code;
    const drops = structure
      .split("\n")
      .filter((line) => /`(DROP|ALTER TABLE)|DROP (COLUMN|CONSTRAINT|TABLE|INDEX)/.test(line));
    expect(drops.length).toBeGreaterThanOrEqual(4);
    for (const line of drops) {
      // Each drop ends with a quoted name: `...${quoteIdentifier(x)}` or `...${quoteQualified(a, b)}`, then the template closes.
      if (/DROP (COLUMN|CONSTRAINT|TABLE|INDEX)/.test(line)) {
        expect(line).toMatch(
          /DROP (COLUMN|CONSTRAINT|TABLE|INDEX) \$\{quote(Identifier|Qualified)\([^`]*\)\}`/,
        );
      }
    }
  });

  it.each([
    "CONCURRENTLY",
    "USING",
    "CHECK \\(",
    "TRUNCATE",
    "EXECUTE",
    "COPY ",
    "GRANT ",
    "REVOKE ",
  ])("never writes %s into a statement", (word) => {
    for (const { file, code } of all) {
      // Sentences for people may say "check"; SQL keywords here are upper case.
      expect([file, new RegExp(word).test(code)]).toEqual([file, false]);
    }
  });

  it("never logs", () => {
    for (const { file, code } of all) {
      expect([file, /console\.|process\.stdout|process\.stderr/.test(code)]).toEqual([file, false]);
    }
  });

  it("the only read-write transaction is in connection/write.ts", () => {
    const begins = all.filter((s) => /"BEGIN"/.test(s.code)).map((s) => s.file);
    expect(begins).toEqual(["write.ts"]);
  });
});
