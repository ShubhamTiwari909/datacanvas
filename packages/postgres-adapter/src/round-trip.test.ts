/**
 * The round-trip harness (`docs/migration-studio-plan.md`, milestone M0): one real scenario that
 * must pass (add a column to a table that has rows), and the proof that the oracle is not blind:
 * a wrong migration, a wrong rollback and a difference that only the definition detail sees are
 * each reported.
 *
 * Skipped unless DATACANVAS_TEST_PG_URL is set. Each scenario makes two throwaway databases.
 */
import { describe, expect, it } from "vitest";
import { runRoundTrip, type Scenario } from "./testing/round-trip.js";
import { testDatabaseUrl } from "./testing/index.js";

const ITEMS = "CREATE SCHEMA rt; CREATE TABLE rt.items (id int PRIMARY KEY, name text NOT NULL);";
const ITEMS_WITH_NOTE =
  "CREATE SCHEMA rt; CREATE TABLE rt.items (id int PRIMARY KEY, name text NOT NULL, note text);";
const ROWS = "INSERT INTO rt.items (id, name) VALUES (1, 'a'), (2, 'b')";

const addColumn: Scenario = {
  name: "add a nullable column to a table that has rows",
  from: ITEMS,
  to: ITEMS_WITH_NOTE,
  data: ROWS,
  up: "ALTER TABLE rt.items ADD COLUMN note text;",
  down: "ALTER TABLE rt.items DROP COLUMN note;",
};

describe.skipIf(!testDatabaseUrl())("the round-trip oracle", () => {
  it("passes a correct migration and its rollback: nothing differs afterwards", async () => {
    const result = await runRoundTrip(addColumn);
    expect(result.upDifferences).toEqual([]);
    expect(result.downDifferences).toEqual([]);
  }, 60_000);

  it("reports a migration that does not reach the target", async () => {
    const result = await runRoundTrip({
      ...addColumn,
      // The wrong type: the structure differs from the target, and the oracle must say where.
      up: "ALTER TABLE rt.items ADD COLUMN note varchar(5);",
      down: undefined,
    });
    expect(result.upDifferences.join("\n")).toContain("note");
    expect(result.downDifferences).toBeNull();
  }, 60_000);

  it("reports a rollback that does not restore the starting point", async () => {
    const result = await runRoundTrip({
      ...addColumn,
      down: "SELECT 1;",
    });
    expect(result.upDifferences).toEqual([]);
    expect(result.downDifferences?.join("\n")).toContain("note");
  }, 60_000);

  it("sees a difference that only the definition detail records: identity", async () => {
    const scenario: Scenario = {
      name: "make a column an identity",
      from: "CREATE SCHEMA rt; CREATE TABLE rt.t (id int PRIMARY KEY);",
      to: "CREATE SCHEMA rt; CREATE TABLE rt.t (id int GENERATED ALWAYS AS IDENTITY PRIMARY KEY);",
      up: "SELECT 1;",
    };
    const blind = await runRoundTrip(scenario);
    // The structure sees the sequence an identity brings with it, but nothing in a name, a type, a
    // nullability or a default says the column IS an identity: only the detail does.
    const lines = blind.upDifferences.join("\n");
    expect(lines).toContain("column rt.t.id");
    expect(lines).toContain('"identity":"always"');
    expect(blind.upDifferences.filter((l) => l.startsWith("column "))).toHaveLength(1);

    const right = await runRoundTrip({
      ...scenario,
      up: "ALTER TABLE rt.t ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY;",
      down: "ALTER TABLE rt.t ALTER COLUMN id DROP IDENTITY;",
    });
    expect(right.upDifferences).toEqual([]);
    expect(right.downDifferences).toEqual([]);
  }, 90_000);
});
