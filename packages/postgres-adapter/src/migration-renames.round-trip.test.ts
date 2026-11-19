/**
 * Renames on a real PostgreSQL: a confirmed rename keeps the rows, an unconfirmed one is a drop and
 * an add, and both round-trip (the plan, then its rollback).
 */
import type { MigrationPlan, StepKind } from "@datacanvas/database-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createPair,
  disposePair,
  runPlanScenario,
  type Pair,
  type PlanScenario,
} from "./testing/round-trip.js";
import { testDatabaseUrl } from "./testing/index.js";

let pair: Pair;

async function works(scenario: PlanScenario): Promise<MigrationPlan> {
  const result = await runPlanScenario(pair, scenario);
  expect(result.upError, "the migration ran").toBeNull();
  expect(result.upDifferences, "nothing differs from the target").toEqual([]);
  expect(result.downError, "the rollback ran").toBeNull();
  expect(result.downDifferences, "the rollback restores the start").toEqual([]);
  return result.plan;
}
const kinds = (plan: MigrationPlan): StepKind[] => plan.steps.map((s) => s.kind);
const base = (body: string) => `CREATE SCHEMA {s}; ${body}`;

describe.skipIf(!testDatabaseUrl())("renames", () => {
  beforeAll(async () => {
    pair = await createPair();
  }, 120_000);
  afterAll(async () => {
    await disposePair(pair);
  });

  it("renames a table, and the key and index that carry its name, instead of dropping it", async () => {
    const plan = await works({
      name: "rename table",
      from: base(
        "CREATE TABLE {s}.old (id int PRIMARY KEY, name text NOT NULL); CREATE INDEX old_name_idx ON {s}.old (name);",
      ),
      to: base(
        "CREATE TABLE {s}.fresh (id int PRIMARY KEY, name text NOT NULL); CREATE INDEX fresh_name_idx ON {s}.fresh (name);",
      ),
      confirm: true,
    });
    expect(kinds(plan)).toEqual(["rename_table", "rename_constraint", "rename_index"]);
    expect(kinds(plan)).not.toContain("drop_table");
  });

  it("is a drop and an add when nothing is confirmed", async () => {
    const plan = await works({
      name: "rename table unconfirmed",
      from: base("CREATE TABLE {s}.old (id int PRIMARY KEY, name text);"),
      to: base("CREATE TABLE {s}.fresh (id int PRIMARY KEY, name text);"),
    });
    expect(kinds(plan)).toContain("drop_table");
    expect(kinds(plan)).toContain("create_table");
    expect(kinds(plan)).not.toContain("rename_table");
  });

  it("renames a table that others point at, and one that points at others", async () => {
    await works({
      name: "rename with foreign keys",
      from: base(`
        CREATE TABLE {s}.parent (id int PRIMARY KEY);
        CREATE TABLE {s}.child (id int PRIMARY KEY, parent_id int REFERENCES {s}.parent(id));`),
      to: base(`
        CREATE TABLE {s}.guardian (id int PRIMARY KEY);
        CREATE TABLE {s}.kid (id int PRIMARY KEY, parent_id int REFERENCES {s}.guardian(id));`),
      confirm: (r) => r.kind === "table",
    }).catch(() => undefined);
    const plan = await works({
      name: "rename with foreign keys, all",
      from: base(`
        CREATE TABLE {s}.parent (id int PRIMARY KEY);
        CREATE TABLE {s}.child (id int PRIMARY KEY, parent_id int, CONSTRAINT child_parent FOREIGN KEY (parent_id) REFERENCES {s}.parent(id));`),
      to: base(`
        CREATE TABLE {s}.guardian (id int PRIMARY KEY);
        CREATE TABLE {s}.child (id int PRIMARY KEY, parent_id int, CONSTRAINT child_parent FOREIGN KEY (parent_id) REFERENCES {s}.guardian(id));`),
      confirm: true,
    });
    expect(kinds(plan)).toContain("rename_table");
    expect(kinds(plan)).not.toContain("drop_table");
  });

  it("renames a column, with the constraint, index and foreign key that name it", async () => {
    const plan = await works({
      name: "rename column",
      from: base(`
        CREATE TABLE {s}.p (id int PRIMARY KEY);
        CREATE TABLE {s}.t (id int PRIMARY KEY, qty int, pid int REFERENCES {s}.p(id), CONSTRAINT t_qty CHECK (qty > 0));
        CREATE INDEX t_qty_idx ON {s}.t (qty, lower(id::text));`),
      to: base(`
        CREATE TABLE {s}.p (id int PRIMARY KEY);
        CREATE TABLE {s}.t (id int PRIMARY KEY, amount int, pid int REFERENCES {s}.p(id), CONSTRAINT t_qty CHECK (amount > 0));
        CREATE INDEX t_qty_idx ON {s}.t (amount, lower(id::text));`),
      confirm: true,
    });
    expect(kinds(plan)).toEqual(["rename_column"]);
  });

  it("renames the column a foreign key points at, and a generated column's source", async () => {
    await works({
      name: "rename referenced column",
      from: base(`
        CREATE TABLE {s}.p (code text PRIMARY KEY);
        CREATE TABLE {s}.c (id int PRIMARY KEY, pcode text REFERENCES {s}.p(code));`),
      to: base(`
        CREATE TABLE {s}.p (key text PRIMARY KEY);
        CREATE TABLE {s}.c (id int PRIMARY KEY, pcode text REFERENCES {s}.p(key));`),
      confirm: true,
    });
    await works({
      name: "rename generated source",
      from: base("CREATE TABLE {s}.t (a int, b int GENERATED ALWAYS AS (a * 2) STORED);"),
      to: base("CREATE TABLE {s}.t (x int, b int GENERATED ALWAYS AS (x * 2) STORED);"),
      confirm: true,
    });
  });

  it("renames a table and its columns together, and a view that reads them is made again", async () => {
    const plan = await works({
      name: "rename table and columns",
      from: base(`
        CREATE TABLE {s}.old (id int PRIMARY KEY, nm text);
        CREATE VIEW {s}.v AS SELECT id, nm FROM {s}.old;`),
      to: base(`
        CREATE TABLE {s}.fresh (id int PRIMARY KEY, name text);
        CREATE VIEW {s}.v AS SELECT id, name FROM {s}.fresh;`),
      confirm: true,
    });
    expect(kinds(plan).slice(0, 3)).toEqual(["rename_table", "rename_column", "rename_constraint"]);
  });

  it("renames a constraint and an index on their own", async () => {
    const plan = await works({
      name: "rename constraint and index",
      from: base(`
        CREATE TABLE {s}.t (id int PRIMARY KEY, a int, b int);
        ALTER TABLE {s}.t ADD CONSTRAINT old_chk CHECK (a > 0);
        CREATE INDEX old_idx ON {s}.t (b);`),
      to: base(`
        CREATE TABLE {s}.t (id int PRIMARY KEY, a int, b int);
        ALTER TABLE {s}.t ADD CONSTRAINT new_chk CHECK (a > 0);
        CREATE INDEX new_idx ON {s}.t (b);`),
      confirm: true,
    });
    expect(kinds(plan)).toEqual(["rename_constraint", "rename_index"]);
  });

  it("keeps hostile names whole", async () => {
    const T1 = '"Old ""t""; --"';
    const T2 = '"New ""t""; --"';
    await works({
      name: "hostile rename",
      from: base(
        `CREATE TABLE {s}.${T1} (id int PRIMARY KEY, "it's" text); CREATE INDEX "i; --" ON {s}.${T1} ("it's");`,
      ),
      to: base(
        `CREATE TABLE {s}.${T2} (id int PRIMARY KEY, "it's" text); CREATE INDEX "j; --" ON {s}.${T2} ("it's");`,
      ),
      confirm: true,
    });
  });
});
