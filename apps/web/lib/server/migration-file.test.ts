/**
 * The migration file (1.5.2): the structure changes applied in a session, as
 * one SQL script in a transaction. Row changes are counted, never written.
 */
import { describe, expect, it } from "vitest";
import { buildMigration, migrationFilename, type MigrationStep } from "./migration-file";

const at = "2026-11-18T10:20:30.000Z";
const step = (over: Partial<MigrationStep> = {}): MigrationStep => ({
  at,
  kind: "add_column",
  table: { schema: "public", name: "users" },
  sql: 'ALTER TABLE "public"."users" ADD COLUMN "age" integer;',
  ...over,
});

describe("buildMigration", () => {
  it("wraps the steps in one transaction, in the order they were applied", () => {
    const sql = buildMigration({
      database: "shop",
      generatedAt: at,
      steps: [
        step(),
        step({ kind: "drop_column", sql: 'ALTER TABLE "public"."users" DROP COLUMN "x";' }),
      ],
      rowChanges: 0,
    });
    const lines = sql.split("\n");
    expect(lines).toContain("BEGIN;");
    expect(lines.at(-2)).toBe("COMMIT;");
    expect(sql.indexOf("ADD COLUMN")).toBeLessThan(sql.indexOf("DROP COLUMN"));
    expect(sql).toContain("-- Database: shop");
  });

  it("says how many row changes were left out, and never writes one", () => {
    const sql = buildMigration({
      database: "shop",
      generatedAt: at,
      steps: [step()],
      rowChanges: 3,
    });
    expect(sql).toContain("3 row changes were made and are not part of this file");
    expect(sql).not.toMatch(/INSERT|UPDATE|DELETE FROM/);
  });

  it("cannot be broken out of by a name that holds a line break", () => {
    const evil = "t\nDROP TABLE victims; --";
    const sql = buildMigration({
      database: "x\nDROP DATABASE y;",
      generatedAt: at,
      steps: [step({ table: { schema: "public", name: evil } })],
      rowChanges: 0,
    });
    // Every line that is not the script itself is a comment, so nothing in a name can run.
    const named = sql
      .split("\n")
      .filter((l) => l.includes("DROP TABLE victims") || l.includes("DROP DATABASE y"));
    expect(named).toHaveLength(2);
    for (const line of named) expect(line.startsWith("--")).toBe(true);
  });

  it("names the file after the database and the day, safe for a file system", () => {
    expect(migrationFilename("shop", at)).toBe("datacanvas-shop-2026-11-18.sql");
    expect(migrationFilename("../..\\we ird/na:me", at)).toBe(
      "datacanvas-we-ird-na-me-2026-11-18.sql",
    );
    expect(migrationFilename("", at)).toBe("datacanvas-database-2026-11-18.sql");
  });

  it("warns, at the top, when earlier steps were dropped", () => {
    const sql = buildMigration({
      database: "shop",
      generatedAt: at,
      steps: [step()],
      rowChanges: 0,
      omittedSteps: 2,
    });
    expect(sql).toContain("-- WARNING: 2 earlier changes of structure are NOT in this file");
  });

  it("is a comment-only file when nothing of structure changed", () => {
    const sql = buildMigration({ database: "shop", generatedAt: at, steps: [], rowChanges: 2 });
    expect(sql).not.toContain("BEGIN;");
    expect(sql).toContain("No changes of structure");
  });
});
