/**
 * The planner for the objects around the tables, checked on a real PostgreSQL the way the planner
 * for tables is (`migration.round-trip.test.ts`): run the plan on a copy of the starting database,
 * read it again, and nothing may differ from the target; run the rollback, and nothing may differ
 * from the start. `{s}` is the scenario's schema and `{s2}` a second one.
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

describe.skipIf(!testDatabaseUrl())("the planner: the objects around the tables", () => {
  beforeAll(async () => {
    pair = await createPair();
  }, 120_000);
  afterAll(async () => {
    await disposePair(pair);
  });

  describe("schemas and extensions", () => {
    it("creates, comments and drops a schema", async () => {
      const made = await works({
        name: "create schema",
        from: base(""),
        to: base("CREATE SCHEMA {s2}; COMMENT ON SCHEMA {s2} IS 'the second';"),
      });
      expect(kinds(made)).toEqual(["create_schema", "comment_schema"]);
      await works({
        name: "drop schema",
        from: base("CREATE SCHEMA {s2}; COMMENT ON SCHEMA {s2} IS 'the second';"),
        to: base(""),
      });
      await works({
        name: "comment schema",
        from: base("CREATE SCHEMA {s2}; COMMENT ON SCHEMA {s2} IS 'a';"),
        to: base("CREATE SCHEMA {s2}; COMMENT ON SCHEMA {s2} IS 'b';"),
      });
    });

    it("makes a schema with a table in it, and drops one that has its tables dropped first", async () => {
      await works({
        name: "schema with a table",
        from: base(""),
        to: base("CREATE SCHEMA {s2}; CREATE TABLE {s2}.t (id int PRIMARY KEY);"),
      });
      const plan = await works({
        name: "schema and table gone",
        from: base("CREATE SCHEMA {s2}; CREATE TABLE {s2}.t (id int PRIMARY KEY);"),
        to: base(""),
      });
      const order = kinds(plan);
      expect(order.indexOf("drop_table")).toBeLessThan(order.indexOf("drop_schema"));
    });

    it("installs and removes an extension", async () => {
      const cleanup = "DROP EXTENSION IF EXISTS citext CASCADE;";
      await works({
        name: "install extension",
        from: base(""),
        to: base("CREATE EXTENSION citext WITH SCHEMA {s};"),
        cleanup,
      });
      await works({
        name: "remove extension",
        from: base("CREATE EXTENSION citext WITH SCHEMA {s};"),
        to: base(""),
        cleanup,
      });
    });
  });

  describe("types", () => {
    it("creates every kind of type, and a table that uses them", async () => {
      const plan = await works({
        name: "create types",
        from: base(""),
        to: base(`
          CREATE TYPE {s}.mood AS ENUM ('sad', 'ok', 'happy');
          CREATE TYPE {s}.pair AS (a int, b {s}.mood);
          CREATE DOMAIN {s}.posint AS int DEFAULT 1 NOT NULL CHECK (VALUE > 0);
          CREATE TYPE {s}.span AS RANGE (SUBTYPE = int);
          CREATE TABLE {s}.t (id int PRIMARY KEY, m {s}.mood NOT NULL, n {s}.posint, p {s}.pair);
          COMMENT ON TYPE {s}.mood IS 'how it feels';
        `),
      });
      const order = kinds(plan);
      expect(order.indexOf("create_type")).toBeLessThan(order.indexOf("create_table"));
    });

    it("drops types, after the table that used them", async () => {
      const plan = await works({
        name: "drop types",
        from: base(`
          CREATE TYPE {s}.mood AS ENUM ('sad', 'ok');
          CREATE DOMAIN {s}.posint AS int CHECK (VALUE > 0);
          CREATE TABLE {s}.t (id int PRIMARY KEY, m {s}.mood, n {s}.posint);
          COMMENT ON TYPE {s}.mood IS 'how it feels';
        `),
        to: base(""),
      });
      const order = kinds(plan);
      expect(order.indexOf("drop_table")).toBeLessThan(order.indexOf("drop_type"));
    });

    it("adds enum labels at the end, the start and the middle, and says it cannot take them back", async () => {
      const plan = await works({
        name: "enum labels",
        from: base("CREATE TYPE {s}.mood AS ENUM ('b', 'd');"),
        to: base("CREATE TYPE {s}.mood AS ENUM ('a', 'b', 'c', 'd', 'e');"),
      }).catch(() => null);
      // The rollback cannot remove a label, so the starting point is not restored: that is the point.
      expect(plan).toBeNull();
      const result = await runPlanScenario(pair, {
        name: "enum labels, plan only",
        from: base("CREATE TYPE {s}.mood AS ENUM ('b', 'd');"),
        to: base("CREATE TYPE {s}.mood AS ENUM ('a', 'b', 'c', 'd', 'e');"),
      });
      expect(result.upError).toBeNull();
      expect(result.upDifferences).toEqual([]);
      expect(result.plan.steps.map((s) => s.kind)).toEqual([
        "alter_type",
        "alter_type",
        "alter_type",
      ]);
      expect(result.plan.steps.every((s) => s.down === null && !s.transactional)).toBe(true);
      expect(result.plan.reversibility).toBe("none");
    });

    it("does not plan what PostgreSQL cannot do: removing or reordering a label", async () => {
      for (const to of ["('a')", "('b', 'a')"]) {
        const result = await runPlanScenario(pair, {
          name: `enum cannot ${to}`,
          from: base("CREATE TYPE {s}.mood AS ENUM ('a', 'b');"),
          to: base(`CREATE TYPE {s}.mood AS ENUM ${to};`),
        });
        expect(result.plan.steps).toEqual([]);
        expect(result.plan.warnings.join(" ")).toMatch(/cannot do that/);
      }
    });

    it("changes composite types, domains and comments", async () => {
      await works({
        name: "composite attributes",
        from: base("CREATE TYPE {s}.pair AS (a int, b text, c int);"),
        to: base("CREATE TYPE {s}.pair AS (a bigint, b text, d text);"),
      });
      await works({
        name: "domain default and not null",
        from: base("CREATE DOMAIN {s}.d AS int;"),
        to: base("CREATE DOMAIN {s}.d AS int DEFAULT 5 NOT NULL;"),
      });
      await works({
        name: "domain back",
        from: base("CREATE DOMAIN {s}.d AS int DEFAULT 5 NOT NULL;"),
        to: base("CREATE DOMAIN {s}.d AS int DEFAULT 6;"),
      });
      await works({
        name: "type comments",
        from: base("CREATE TYPE {s}.m AS ENUM ('a'); COMMENT ON TYPE {s}.m IS 'one';"),
        to: base("CREATE TYPE {s}.m AS ENUM ('a'); COMMENT ON TYPE {s}.m IS 'two';"),
      });
    });
  });

  describe("sequences", () => {
    it("creates, changes and drops a sequence", async () => {
      await works({
        name: "create sequence",
        from: base(""),
        to: base(
          "CREATE SEQUENCE {s}.n AS bigint INCREMENT BY 5 MINVALUE 10 MAXVALUE 1000 START WITH 20 CACHE 3 CYCLE; COMMENT ON SEQUENCE {s}.n IS 'counts';",
        ),
      });
      await works({
        name: "change sequence",
        from: base("CREATE SEQUENCE {s}.n;"),
        to: base("CREATE SEQUENCE {s}.n AS smallint INCREMENT BY 2 MAXVALUE 100 CACHE 4 CYCLE;"),
      });
      await works({
        name: "drop sequence",
        from: base("CREATE SEQUENCE {s}.n INCREMENT BY 3; COMMENT ON SEQUENCE {s}.n IS 'x';"),
        to: base(""),
      });
    });

    it("makes a table with a serial column, and drops it", async () => {
      await works({
        name: "serial table",
        from: base(""),
        to: base("CREATE TABLE {s}.t (id serial PRIMARY KEY, name text);"),
      });
      await works({
        name: "serial table gone",
        from: base("CREATE TABLE {s}.t (id serial PRIMARY KEY, name text);"),
        to: base(""),
      });
    });

    it("adds and drops a serial column, and moves a sequence between owners", async () => {
      await works({
        name: "add serial column",
        from: base("CREATE TABLE {s}.t (id int PRIMARY KEY);"),
        to: base("CREATE TABLE {s}.t (id int PRIMARY KEY, n serial);"),
      });
      await works({
        name: "drop serial column",
        from: base("CREATE TABLE {s}.t (id int PRIMARY KEY, n serial);"),
        to: base("CREATE TABLE {s}.t (id int PRIMARY KEY);"),
      });
      await works({
        name: "sequence loses its owner",
        from: base(
          "CREATE SEQUENCE {s}.q; CREATE TABLE {s}.t (id int PRIMARY KEY, n int DEFAULT nextval('{s}.q')); ALTER SEQUENCE {s}.q OWNED BY {s}.t.n;",
        ),
        to: base(
          "CREATE SEQUENCE {s}.q; CREATE TABLE {s}.t (id int PRIMARY KEY, n int DEFAULT nextval('{s}.q'));",
        ),
      });
    });

    it("keeps a sequence whose owner goes", async () => {
      await works({
        name: "sequence survives its table",
        from: base(
          "CREATE SEQUENCE {s}.q; CREATE TABLE {s}.t (id int PRIMARY KEY, n int DEFAULT nextval('{s}.q')); ALTER SEQUENCE {s}.q OWNED BY {s}.t.n;",
        ),
        to: base("CREATE SEQUENCE {s}.q;"),
      });
    });
  });

  describe("functions", () => {
    const fn = (body: string, ret = "int", lang = "sql", name = "f") =>
      `CREATE FUNCTION {s}.${name}(a int) RETURNS ${ret} LANGUAGE ${lang} AS $fn$ ${body} $fn$;`;

    it("creates, replaces and drops functions and procedures", async () => {
      await works({
        name: "create functions",
        from: base(""),
        to: base(
          `${fn("SELECT a + 1")} ${fn("BEGIN RETURN a * 2; END;", "int", "plpgsql", "g")} ` +
            "CREATE PROCEDURE {s}.p(x int) LANGUAGE sql AS $p$ SELECT x $p$; " +
            "COMMENT ON FUNCTION {s}.f(int) IS 'adds one'; COMMENT ON PROCEDURE {s}.p(int) IS 'does nothing';",
        ),
      });
      await works({
        name: "replace function",
        from: base(fn("SELECT a + 1")),
        to: base(`${fn("SELECT a + 2")} COMMENT ON FUNCTION {s}.f(int) IS 'now two';`),
      });
      await works({
        name: "drop functions",
        from: base(
          `${fn("SELECT a + 1")} CREATE PROCEDURE {s}.p(x int) LANGUAGE sql AS $p$ SELECT x $p$; COMMENT ON FUNCTION {s}.f(int) IS 'c';`,
        ),
        to: base(""),
      });
    });

    it("tells overloads apart", async () => {
      await works({
        name: "overloads",
        from: base(fn("SELECT a")),
        to: base(
          `${fn("SELECT a")} CREATE FUNCTION {s}.f(a text) RETURNS text LANGUAGE sql AS $o$ SELECT a $o$;`,
        ),
      });
    });

    it("drops and makes a function again when its result type changes", async () => {
      const plan = await works({
        name: "return type",
        from: base(fn("SELECT a")),
        to: base(fn("SELECT a::text", "text")),
      });
      expect(kinds(plan)).toEqual(["drop_function", "create_function"]);
    });

    it("makes a function a table needs before the table, and one that reads the table after it", async () => {
      await works({
        name: "default from a function",
        from: base(""),
        to: base(
          `${fn("SELECT a + 1")} CREATE TABLE {s}.t (id int PRIMARY KEY, n int DEFAULT {s}.f(1));`,
        ),
      });
      await works({
        name: "function reads a new table",
        from: base(""),
        to: base(
          "CREATE TABLE {s}.t (id int PRIMARY KEY); CREATE FUNCTION {s}.total() RETURNS bigint LANGUAGE sql AS $t$ SELECT count(*) FROM {s}.t $t$;",
        ),
      });
    });
  });

  describe("views", () => {
    const t = "CREATE TABLE {s}.t (id int PRIMARY KEY, a int, b text);";

    it("creates, comments and drops views, and orders views that read views", async () => {
      const plan = await works({
        name: "create views",
        from: base(t),
        to: base(`${t}
          CREATE VIEW {s}.v1 AS SELECT id, a FROM {s}.t;
          CREATE VIEW {s}.v2 AS SELECT id FROM {s}.v1;
          COMMENT ON VIEW {s}.v1 IS 'the first';`),
      });
      const created = plan.steps.filter((s) => s.kind === "create_view").map((s) => s.object.name);
      expect(created).toEqual(["v1", "v2"]);
      const dropped = await works({
        name: "drop views",
        from: base(
          `${t} CREATE VIEW {s}.v1 AS SELECT id, a FROM {s}.t; CREATE VIEW {s}.v2 AS SELECT id FROM {s}.v1;`,
        ),
        to: base(t),
      });
      expect(dropped.steps.filter((s) => s.kind === "drop_view").map((s) => s.object.name)).toEqual(
        ["v2", "v1"],
      );
    });

    it("replaces a view in place when it keeps its columns, and makes it again when it does not", async () => {
      const replaced = await works({
        name: "replace view",
        from: base(`${t} CREATE VIEW {s}.v AS SELECT id FROM {s}.t;`),
        to: base(`${t} CREATE VIEW {s}.v AS SELECT id, a FROM {s}.t;`),
      });
      expect(kinds(replaced)).toEqual(["replace_view"]);
      const again = await works({
        name: "rebuild view",
        from: base(`${t} CREATE VIEW {s}.v AS SELECT id, a FROM {s}.t;`),
        to: base(`${t} CREATE VIEW {s}.v AS SELECT id FROM {s}.t;`),
      });
      expect(kinds(again)).toEqual(["drop_view", "create_view"]);
    });

    it("makes dependent views again around a view that must be", async () => {
      const plan = await works({
        name: "view chain",
        from: base(`${t}
          CREATE VIEW {s}.v1 AS SELECT id, a FROM {s}.t;
          CREATE VIEW {s}.v2 AS SELECT id, a FROM {s}.v1;`),
        to: base(`${t}
          CREATE VIEW {s}.v1 AS SELECT id FROM {s}.t;
          CREATE VIEW {s}.v2 AS SELECT id, a FROM {s}.t;`),
      });
      expect(plan.steps.filter((s) => s.kind === "drop_view").length).toBe(2);
    });

    it("makes a view again around a column that is dropped or retyped", async () => {
      await works({
        name: "view over a dropped column",
        from: base(`${t} CREATE VIEW {s}.v AS SELECT id, b FROM {s}.t;`),
        to: base(
          `CREATE TABLE {s}.t (id int PRIMARY KEY, a int); CREATE VIEW {s}.v AS SELECT id, a FROM {s}.t;`,
        ),
      });
      await works({
        name: "view over a retyped column",
        from: base(`${t} CREATE VIEW {s}.v AS SELECT id, a FROM {s}.t;`),
        to: base(
          `CREATE TABLE {s}.t (id int PRIMARY KEY, a bigint, b text); CREATE VIEW {s}.v AS SELECT id, a FROM {s}.t;`,
        ),
      });
    });

    it("creates, changes and drops materialized views with their indexes", async () => {
      const m = (select: string, index: string) =>
        base(`${t} CREATE MATERIALIZED VIEW {s}.m AS ${select}; ${index}`);
      await works({
        name: "create matview",
        from: base(t),
        to: m(
          "SELECT id, a FROM {s}.t",
          "CREATE UNIQUE INDEX m_id ON {s}.m (id); COMMENT ON MATERIALIZED VIEW {s}.m IS 'cached';",
        ),
      });
      await works({
        name: "change matview",
        from: m("SELECT id, a FROM {s}.t", "CREATE UNIQUE INDEX m_id ON {s}.m (id);"),
        to: m("SELECT id FROM {s}.t", "CREATE UNIQUE INDEX m_id ON {s}.m (id);"),
      });
      await works({
        name: "drop matview",
        from: m("SELECT id, a FROM {s}.t", "CREATE UNIQUE INDEX m_id ON {s}.m (id);"),
        to: base(t),
      });
    });
  });

  describe("triggers", () => {
    const setup = `
      CREATE TABLE {s}.t (id int PRIMARY KEY, a int);
      CREATE FUNCTION {s}.touch() RETURNS trigger LANGUAGE plpgsql AS $x$ BEGIN RETURN NEW; END; $x$;`;

    it("creates, changes, disables and drops a trigger", async () => {
      await works({
        name: "create trigger",
        from: base(setup),
        to: base(
          `${setup} CREATE TRIGGER t_touch BEFORE INSERT OR UPDATE ON {s}.t FOR EACH ROW EXECUTE FUNCTION {s}.touch();`,
        ),
      });
      await works({
        name: "change trigger",
        from: base(
          `${setup} CREATE TRIGGER t_touch BEFORE INSERT ON {s}.t FOR EACH ROW EXECUTE FUNCTION {s}.touch();`,
        ),
        to: base(
          `${setup} CREATE TRIGGER t_touch AFTER INSERT OR DELETE ON {s}.t FOR EACH STATEMENT EXECUTE FUNCTION {s}.touch();`,
        ),
      });
      const plan = await works({
        name: "disable trigger",
        from: base(
          `${setup} CREATE TRIGGER t_touch BEFORE INSERT ON {s}.t FOR EACH ROW EXECUTE FUNCTION {s}.touch();`,
        ),
        to: base(
          `${setup} CREATE TRIGGER t_touch BEFORE INSERT ON {s}.t FOR EACH ROW EXECUTE FUNCTION {s}.touch(); ALTER TABLE {s}.t DISABLE TRIGGER t_touch;`,
        ),
      });
      expect(kinds(plan)).toEqual(["alter_trigger"]);
      await works({
        name: "drop trigger and function",
        from: base(
          `${setup} CREATE TRIGGER t_touch BEFORE INSERT ON {s}.t FOR EACH ROW EXECUTE FUNCTION {s}.touch();`,
        ),
        to: base("CREATE TABLE {s}.t (id int PRIMARY KEY, a int);"),
      });
    });

    it("makes a trigger on a new table, drops one with its table, and keeps one across a rebuilt view", async () => {
      await works({
        name: "trigger on new table",
        from: base(
          `CREATE FUNCTION {s}.touch() RETURNS trigger LANGUAGE plpgsql AS $x$ BEGIN RETURN NEW; END; $x$;`,
        ),
        to: base(
          `${setup} CREATE TRIGGER t_touch BEFORE INSERT ON {s}.t FOR EACH ROW EXECUTE FUNCTION {s}.touch();`,
        ),
      });
      await works({
        name: "trigger goes with its table",
        from: base(
          `${setup} CREATE TRIGGER t_touch BEFORE INSERT ON {s}.t FOR EACH ROW EXECUTE FUNCTION {s}.touch();`,
        ),
        to: base(
          `CREATE FUNCTION {s}.touch() RETURNS trigger LANGUAGE plpgsql AS $x$ BEGIN RETURN NEW; END; $x$;`,
        ),
      });
      const view = (cols: string) => `${setup}
        CREATE VIEW {s}.v AS SELECT ${cols} FROM {s}.t;
        CREATE TRIGGER v_touch INSTEAD OF INSERT ON {s}.v FOR EACH ROW EXECUTE FUNCTION {s}.touch();`;
      await works({
        name: "trigger on rebuilt view",
        from: base(view("id, a")),
        to: base(view("id")),
      });
    });
  });

  describe("policies and row security", () => {
    const t = "CREATE TABLE {s}.t (id int PRIMARY KEY, owner text);";
    const rls = "ALTER TABLE {s}.t ENABLE ROW LEVEL SECURITY;";

    it("creates, changes and drops policies", async () => {
      await works({
        name: "create policy",
        from: base(`${t} ${rls}`),
        to: base(
          `${t} ${rls} CREATE POLICY p ON {s}.t AS RESTRICTIVE FOR SELECT TO PUBLIC USING (owner = current_user);`,
        ),
      });
      await works({
        name: "alter policy",
        from: base(`${t} ${rls} CREATE POLICY p ON {s}.t USING (owner = current_user);`),
        to: base(`${t} ${rls} CREATE POLICY p ON {s}.t USING (owner <> 'x') WITH CHECK (id > 0);`),
      });
      await works({
        name: "policy loses an expression",
        from: base(
          `${t} ${rls} CREATE POLICY p ON {s}.t USING (owner = current_user) WITH CHECK (id > 0);`,
        ),
        to: base(`${t} ${rls} CREATE POLICY p ON {s}.t USING (owner = current_user);`),
      });
      await works({
        name: "policy changes command",
        from: base(`${t} ${rls} CREATE POLICY p ON {s}.t FOR SELECT USING (true);`),
        to: base(`${t} ${rls} CREATE POLICY p ON {s}.t FOR UPDATE USING (true);`),
      });
      await works({
        name: "drop policy",
        from: base(`${t} ${rls} CREATE POLICY p ON {s}.t USING (true);`),
        to: base(`${t} ${rls}`),
      });
    });

    it("turns row security on, forces it, and turns it off", async () => {
      await works({ name: "rls on", from: base(t), to: base(`${t} ${rls}`) });
      await works({
        name: "rls forced",
        from: base(`${t} ${rls}`),
        to: base(`${t} ${rls} ALTER TABLE {s}.t FORCE ROW LEVEL SECURITY;`),
      });
      await works({
        name: "rls off",
        from: base(`${t} ${rls} ALTER TABLE {s}.t FORCE ROW LEVEL SECURITY;`),
        to: base(t),
      });
    });

    it("makes a table with policies, and drops one", async () => {
      const full = `${t} ${rls} CREATE POLICY p ON {s}.t USING (owner = current_user);`;
      await works({ name: "new table with policy", from: base(""), to: base(full) });
      await works({ name: "table with policy gone", from: base(full), to: base("") });
    });
  });

  describe("hostile names", () => {
    const Q = (name: string) => `"${name.replace(/"/g, '""')}"`;
    const T = Q('Tab "le"; DROP TABLE x; --');
    const V = Q("vi\new'; --");
    const F = Q('fn "x"; --');
    const TY = Q("ty$$pe; --");
    const SQ = Q("se\nq'; --");
    const TR = Q('tr"ig; --');
    const PO = Q("po'l; --");
    const COMMENT = "it's; DROP TABLE z; -- \\ $$ */";
    const q = (c: string) => `'${c.replace(/'/g, "''")}'`;
    const all = `
      CREATE TYPE {s}.${TY} AS ENUM ('a''b', 'c;d');
      CREATE SEQUENCE {s}.${SQ};
      CREATE TABLE {s}.${T} (id int PRIMARY KEY, owner text, kind {s}.${TY});
      CREATE FUNCTION {s}.${F}() RETURNS trigger LANGUAGE plpgsql AS $fn$ BEGIN RETURN NEW; END; $fn$;
      CREATE VIEW {s}.${V} AS SELECT id FROM {s}.${T};
      CREATE TRIGGER ${TR} BEFORE INSERT ON {s}.${T} FOR EACH ROW EXECUTE FUNCTION {s}.${F}();
      ALTER TABLE {s}.${T} ENABLE ROW LEVEL SECURITY;
      CREATE POLICY ${PO} ON {s}.${T} USING (owner = ${q("it's")});
      COMMENT ON VIEW {s}.${V} IS ${q(COMMENT)};
      COMMENT ON SEQUENCE {s}.${SQ} IS ${q(COMMENT)};
      COMMENT ON TYPE {s}.${TY} IS ${q(COMMENT)};`;

    it("creates and drops objects whose names are made to break a script", async () => {
      await works({ name: "hostile objects", from: base(""), to: base(all) });
      await works({ name: "hostile objects gone", from: base(all), to: base("") });
    });
  });

  describe("all together", () => {
    it("plans a whole application's worth of change, in an order that runs", async () => {
      const old = `
        CREATE TYPE {s}.status AS ENUM ('new', 'done');
        CREATE TABLE {s}.orders (id serial PRIMARY KEY, status {s}.status NOT NULL, total numeric(10,2));
        CREATE VIEW {s}.open_orders AS SELECT id, total FROM {s}.orders WHERE status = 'new';`;
      const next = `
        CREATE TYPE {s}.status AS ENUM ('new', 'paid', 'done');
        CREATE TABLE {s}.orders (id serial PRIMARY KEY, status {s}.status NOT NULL, total numeric(12,2), note text);
        CREATE TABLE {s}.audit (id serial PRIMARY KEY, order_id int REFERENCES {s}.orders(id), at timestamptz DEFAULT now());
        CREATE VIEW {s}.open_orders AS SELECT id, total, note FROM {s}.orders WHERE status <> 'done';
        CREATE FUNCTION {s}.log_order() RETURNS trigger LANGUAGE plpgsql AS $x$ BEGIN INSERT INTO {s}.audit (order_id) VALUES (NEW.id); RETURN NEW; END; $x$;
        CREATE TRIGGER orders_log AFTER INSERT ON {s}.orders FOR EACH ROW EXECUTE FUNCTION {s}.log_order();`;
      const result = await runPlanScenario(pair, {
        name: "everything",
        from: base(old),
        to: base(next),
      });
      expect(result.upError).toBeNull();
      expect(result.upDifferences).toEqual([]);
    });
  });
});
