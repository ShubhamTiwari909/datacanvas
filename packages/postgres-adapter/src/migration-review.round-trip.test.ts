/**
 * Cases the independent review of the generator (1.7.0) found, each as a round trip on a real
 * PostgreSQL: the plan, then its rollback, must leave nothing different.
 */
import type { MigrationPlan } from "@datacanvas/database-core";
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
const base = (body: string) => `CREATE SCHEMA {s}; ${body}`;

describe.skipIf(!testDatabaseUrl())("what the review found", () => {
  beforeAll(async () => {
    pair = await createPair();
  }, 120_000);
  afterAll(async () => {
    await disposePair(pair);
  });

  it("writes a collation whose name has a dot as its schema and its name", async () => {
    await works({
      name: "dotted collation, changed",
      from: base("CREATE TABLE {s}.t (id int PRIMARY KEY, n text);"),
      to: base('CREATE TABLE {s}.t (id int PRIMARY KEY, n text COLLATE "C.utf8");'),
    });
    await works({
      name: "dotted collation, new table",
      from: base(""),
      to: base('CREATE TABLE {s}.t (id int PRIMARY KEY, n text COLLATE "en_US.utf8");'),
    });
  });

  describe("renaming a column that owns a sequence", () => {
    it("keeps an identity column's sequence", async () => {
      const plan = await works({
        name: "rename identity column",
        from: base("CREATE TABLE {s}.t (id int GENERATED ALWAYS AS IDENTITY PRIMARY KEY, n text);"),
        to: base(
          "CREATE TABLE {s}.t (ident int GENERATED ALWAYS AS IDENTITY PRIMARY KEY, n text);",
        ),
        confirm: true,
      });
      expect(plan.steps.map((s) => s.kind)).not.toContain("drop_sequence");
    });
    it("renames a serial column's sequence, so the numbering carries on", async () => {
      const plan = await works({
        name: "rename serial column",
        from: base("CREATE TABLE {s}.t (id serial PRIMARY KEY, n text);"),
        to: base("CREATE TABLE {s}.t (ident serial PRIMARY KEY, n text);"),
        confirm: true,
      });
      const kinds = plan.steps.map((s) => s.kind);
      expect(kinds).toContain("rename_sequence");
      expect(kinds).not.toContain("create_sequence");
      expect(kinds).not.toContain("drop_sequence");
    });
  });

  describe("a type change and a default together", () => {
    it("drops a default that cannot be cast, then sets the new one", async () => {
      const plan = await works({
        name: "type and default",
        from: base("CREATE TABLE {s}.t (id int PRIMARY KEY, a text DEFAULT 'abc');"),
        to: base("CREATE TABLE {s}.t (id int PRIMARY KEY, a integer DEFAULT 5);"),
      });
      const kinds = plan.steps.map((s) => s.kind);
      expect(kinds.indexOf("drop_default")).toBeLessThan(kinds.indexOf("alter_column_type"));
      expect(kinds.indexOf("alter_column_type")).toBeLessThan(kinds.indexOf("set_default"));
    });
    it("does the same when the default stays the same text and the type needs USING", async () => {
      await works({
        name: "type with the same default text",
        from: base("CREATE TABLE {s}.t (id int PRIMARY KEY, a text DEFAULT '1');"),
        to: base("CREATE TABLE {s}.t (id int PRIMARY KEY, a integer DEFAULT 1);"),
      });
    });
  });

  it("makes a function that reads a column after the column is added", async () => {
    await works({
      name: "function reads an added column",
      from: base("CREATE TABLE {s}.t (id int PRIMARY KEY);"),
      to: base(
        "CREATE TABLE {s}.t (id int PRIMARY KEY, n int); CREATE FUNCTION {s}.total() RETURNS bigint LANGUAGE sql AS $f$ SELECT sum(n) FROM {s}.t $f$;",
      ),
    });
  });

  it("makes a policy and a trigger again around a column that is retyped", async () => {
    const t = (type: string) => `
      CREATE TABLE {s}.t (id int PRIMARY KEY, owner ${type});
      ALTER TABLE {s}.t ENABLE ROW LEVEL SECURITY;
      CREATE POLICY p ON {s}.t USING (owner IS NOT NULL);
      CREATE FUNCTION {s}.f() RETURNS trigger LANGUAGE plpgsql AS $x$ BEGIN RETURN NEW; END; $x$;
      CREATE TRIGGER tr BEFORE UPDATE OF owner ON {s}.t FOR EACH ROW EXECUTE FUNCTION {s}.f();`;
    await works({
      name: "policy and trigger on a retyped column",
      from: base(t("int")),
      to: base(t("bigint")),
    });
  });

  it("lists, for a column that is added, what has to wait for it", async () => {
    const plan = await works({
      name: "dependents of an added column",
      from: base("CREATE TABLE {s}.t (id int PRIMARY KEY);"),
      to: base(`
        CREATE TABLE {s}.t (id int PRIMARY KEY, n int CONSTRAINT n_pos CHECK (n > 0));
        COMMENT ON COLUMN {s}.t.n IS 'the n';
        CREATE INDEX t_n ON {s}.t (n);`),
    });
    const add = plan.steps.find((s) => s.kind === "add_column")!;
    for (const kind of ["comment_column", "add_constraint", "create_index"] as const) {
      expect(plan.steps.find((s) => s.kind === kind)!.dependsOn, kind).toContain(add.id);
    }
  });

  it("says a rollback that rounds is not a full rollback", async () => {
    const result = await runPlanScenario(pair, {
      name: "rounding rollback",
      from: base("CREATE TABLE {s}.t (id int PRIMARY KEY, n integer);"),
      to: base("CREATE TABLE {s}.t (id int PRIMARY KEY, n numeric(10,2));"),
    });
    expect(result.plan.steps.find((s) => s.kind === "alter_column_type")!.reversibility).toBe(
      "data_lost",
    );
  });

  describe("unlogged tables and storage options", () => {
    it("makes a table unlogged and with options, and drops it again", async () => {
      await works({
        name: "create unlogged",
        from: base(""),
        to: base("CREATE UNLOGGED TABLE {s}.t (id int PRIMARY KEY, n int) WITH (fillfactor=70);"),
      });
      await works({
        name: "drop unlogged",
        from: base("CREATE UNLOGGED TABLE {s}.t (id int PRIMARY KEY, n int) WITH (fillfactor=70);"),
        to: base(""),
      });
    });
    it("switches logging and changes, adds and removes options", async () => {
      const plan = await works({
        name: "logging on",
        from: base("CREATE TABLE {s}.t (id int PRIMARY KEY, n int);"),
        to: base("CREATE UNLOGGED TABLE {s}.t (id int PRIMARY KEY, n int);"),
      });
      expect(plan.steps.map((s) => s.kind)).toEqual(["set_table_logging"]);
      await works({
        name: "logging off",
        from: base("CREATE UNLOGGED TABLE {s}.t (id int PRIMARY KEY, n int);"),
        to: base("CREATE TABLE {s}.t (id int PRIMARY KEY, n int);"),
      });
      await works({
        name: "options",
        from: base(
          "CREATE TABLE {s}.t (id int PRIMARY KEY) WITH (fillfactor=70, autovacuum_enabled=false);",
        ),
        to: base(
          "CREATE TABLE {s}.t (id int PRIMARY KEY) WITH (fillfactor=90, toast_tuple_target=4096);",
        ),
      });
    });
  });
});
