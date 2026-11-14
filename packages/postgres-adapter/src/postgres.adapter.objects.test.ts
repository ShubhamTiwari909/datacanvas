/**
 * `getObjects()` against a real PostgreSQL: view definitions and what they
 * read, enums and other types, sequences, functions, triggers, extensions and
 * row-level-security policies.
 *
 * Skipped unless DATACANVAS_TEST_PG_URL is set (see the integration test).
 * Runs in its own throwaway database. The extension test needs the contrib
 * module `pg_trgm`, which the official PostgreSQL images and packages include.
 */
import { type DatabaseObjects } from "@datacanvas/database-core";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresAdapter } from "./postgres.adapter.js";
import { createTestDatabase, testDatabaseUrl, type TestDatabase } from "./testing/index.js";
import { decodeTriggerType, normalizeArguments } from "./introspection/objects.js";

const SQL = `
  COMMENT ON VIEW active_users IS 'Customers who joined recently';

  CREATE TYPE mood AS ENUM ('sad', 'ok', 'happy');
  COMMENT ON TYPE mood IS 'How someone feels';
  CREATE TYPE address_t AS (street text, zip varchar(10));
  CREATE DOMAIN positive_int AS integer NOT NULL DEFAULT 1 CHECK (VALUE > 0);
  CREATE TYPE int_span AS RANGE (subtype = integer);

  CREATE SEQUENCE ticket_seq AS bigint START 100 INCREMENT 5 MINVALUE 10 MAXVALUE 9000000000 CACHE 10 CYCLE;

  CREATE TABLE gadgets (
    id   integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    mood mood,
    n    positive_int,
    note text
  );

  CREATE VIEW gadget_view AS SELECT id, note FROM gadgets;
  CREATE VIEW view_of_view AS SELECT id FROM active_users;
  CREATE VIEW "Odd ""View" AS SELECT g.id, o.status FROM gadgets g JOIN orders o ON o.id = g.id;

  CREATE FUNCTION add_one(a integer) RETURNS integer LANGUAGE sql IMMUTABLE AS $$ SELECT a + 1 $$;
  CREATE FUNCTION add_one(a numeric) RETURNS numeric LANGUAGE sql IMMUTABLE AS $$ SELECT a + 1 $$;
  COMMENT ON FUNCTION add_one(integer) IS 'Adds one';
  CREATE FUNCTION who() RETURNS text LANGUAGE sql STABLE SECURITY DEFINER AS $$ SELECT current_user::text $$;
  CREATE PROCEDURE do_nothing(IN x integer) LANGUAGE plpgsql AS $$ BEGIN NULL; END $$;
  CREATE FUNCTION touch() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;

  CREATE TRIGGER gadgets_touch BEFORE INSERT OR UPDATE ON gadgets
    FOR EACH ROW EXECUTE FUNCTION touch();
  CREATE TRIGGER gadgets_stmt AFTER DELETE OR TRUNCATE ON gadgets
    FOR EACH STATEMENT EXECUTE FUNCTION touch();
  ALTER TABLE gadgets DISABLE TRIGGER gadgets_stmt;
  CREATE TRIGGER gv_ins INSTEAD OF INSERT ON gadget_view
    FOR EACH ROW EXECUTE FUNCTION touch();

  CREATE TABLE ev (id integer, d date) PARTITION BY RANGE (d);
  CREATE TABLE ev_2026 PARTITION OF ev FOR VALUES FROM ('2026-01-01') TO ('2027-01-01');
  CREATE TRIGGER ev_touch AFTER INSERT ON ev FOR EACH ROW EXECUTE FUNCTION touch();

  CREATE EXTENSION pg_trgm;

  ALTER TABLE gadgets ENABLE ROW LEVEL SECURITY;
  CREATE POLICY gadget_reader ON gadgets FOR SELECT TO CURRENT_USER USING (id > 0);
  CREATE POLICY gadget_limit ON gadgets AS RESTRICTIVE FOR UPDATE
    USING (id > 0) WITH CHECK (id < 1000);
  ALTER TABLE products ENABLE ROW LEVEL SECURITY;
  ALTER TABLE products FORCE ROW LEVEL SECURITY;
`;

describe("decodeTriggerType", () => {
  it("reads timing, events and level from the packed bits", () => {
    // 1 row + 2 before + 4 insert + 16 update
    expect(decodeTriggerType(1 + 2 + 4 + 16)).toEqual({
      timing: "before",
      events: ["insert", "update"],
      level: "row",
    });
    // statement-level (no row bit), after (no before bit), delete + truncate
    expect(decodeTriggerType(8 + 32)).toEqual({
      timing: "after",
      events: ["delete", "truncate"],
      level: "statement",
    });
    // instead-of wins over the before bit
    expect(decodeTriggerType(1 + 64 + 4).timing).toBe("instead_of");
  });
});

describe("normalizeArguments", () => {
  it("drops the explicit IN that PostgreSQL 14 and newer print for procedures", () => {
    expect(normalizeArguments("IN x integer")).toBe("x integer");
    expect(normalizeArguments("IN a integer, IN b text")).toBe("a integer, b text");
    expect(normalizeArguments("IN integer, IN numeric(10,2)")).toBe("integer, numeric(10,2)");
  });

  it("keeps OUT and INOUT arguments and leaves a list without IN alone", () => {
    expect(normalizeArguments("a integer, OUT b text")).toBe("a integer, OUT b text");
    expect(normalizeArguments("INOUT a integer")).toBe("INOUT a integer");
    expect(normalizeArguments("")).toBe("");
    expect(normalizeArguments("inet, interval")).toBe("inet, interval");
    expect(normalizeArguments('"in" integer')).toBe('"in" integer');
  });
});

describe.skipIf(!testDatabaseUrl())("PostgresAdapter.getObjects", () => {
  let db: TestDatabase;
  let adapter: PostgresAdapter;
  let objects: DatabaseObjects;

  beforeAll(async () => {
    db = await createTestDatabase();
    const { host, port, username, password } = db.connection;
    const client = new pg.Client({ host, port, user: username, password, database: db.dbName });
    await client.connect();
    try {
      await client.query(SQL);
    } finally {
      await client.end();
    }
    adapter = new PostgresAdapter(db.connection);
    await adapter.connect();
    objects = await adapter.getObjects();
  });

  afterAll(async () => {
    await adapter?.disconnect();
    await db?.dispose();
  });

  describe("views", () => {
    const view = (name: string) => objects.views.find((v) => v.name === name);

    it("returns the query as the server prints it, and whether it is materialized", () => {
      const active = view("active_users")!;
      expect(active).toMatchObject({ schema: "public", materialized: false });
      expect(active.definition).toContain("created_at");
      expect(active.comment).toBe("Customers who joined recently");
      expect(view("daily_sales")).toMatchObject({ schema: "analytics", materialized: true });
    });

    it("lists the tables and views a view reads, once each", () => {
      expect(view("active_users")!.dependsOn).toEqual([{ schema: "public", name: "users" }]);
      expect(view("daily_sales")!.dependsOn).toEqual([
        { schema: "public", name: "order_items" },
        { schema: "public", name: "orders" },
        { schema: "public", name: "products" },
      ]);
      expect(view("gadget_view")!.dependsOn).toEqual([{ schema: "public", name: "gadgets" }]);
    });

    it("a view of a view depends on the view, not on what that view reads", () => {
      expect(view("view_of_view")!.dependsOn).toEqual([{ schema: "public", name: "active_users" }]);
    });

    it("handles a name with a quote and a join of two tables", () => {
      expect(view('Odd "View')!.dependsOn).toEqual([
        { schema: "public", name: "gadgets" },
        { schema: "public", name: "orders" },
      ]);
    });
  });

  describe("types", () => {
    const type = (name: string) => objects.types.find((t) => t.name === name)!;

    it("lists enums with their labels in declared order, and the comment", () => {
      expect(type("mood")).toMatchObject({
        kind: "enum",
        values: ["sad", "ok", "happy"],
        comment: "How someone feels",
      });
    });

    it("lists composite types with their attributes", () => {
      expect(type("address_t")).toMatchObject({
        kind: "composite",
        attributes: [
          { name: "street", dataType: "text" },
          { name: "zip", dataType: "character varying(10)" },
        ],
      });
    });

    it("lists domains with base type, default and constraints", () => {
      const domain = type("positive_int");
      expect(domain).toMatchObject({ kind: "domain", baseType: "integer", defaultValue: "1" });
      expect(domain.constraints[0]).toBe("NOT NULL");
      expect(domain.constraints.join(" ")).toContain("VALUE > 0");
      expect(domain.constraints).toHaveLength(2);
    });

    it("lists range types with the type of their bounds", () => {
      expect(type("int_span")).toMatchObject({ kind: "range", baseType: "integer" });
    });

    it("does not list the row type every table has, or array types", () => {
      const names = objects.types.map((t) => t.name);
      expect(names).toEqual(["address_t", "int_span", "mood", "positive_int"]);
    });
  });

  describe("sequences", () => {
    const sequence = (name: string) => objects.sequences.find((s) => s.name === name)!;

    it("returns the settings as text, and never the current value", () => {
      expect(sequence("ticket_seq")).toEqual({
        schema: "public",
        name: "ticket_seq",
        dataType: "bigint",
        start: "100",
        increment: "5",
        min: "10",
        max: "9000000000",
        cache: "10",
        cycle: true,
        ownedBy: null,
      });
      expect(JSON.stringify(objects.sequences)).not.toMatch(/last_value|is_called/);
    });

    it("says which column owns a serial or identity sequence", () => {
      expect(sequence("users_id_seq").ownedBy).toEqual({
        schema: "public",
        table: "users",
        column: "id",
      });
      expect(sequence("gadgets_id_seq").ownedBy).toEqual({
        schema: "public",
        table: "gadgets",
        column: "id",
      });
    });
  });

  describe("functions", () => {
    it("tells overloads apart by their arguments", () => {
      const addOne = objects.functions.filter((f) => f.name === "add_one");
      expect(addOne.map((f) => f.arguments)).toEqual(["a integer", "a numeric"]);
      expect(addOne[0]).toMatchObject({
        kind: "function",
        returns: "integer",
        language: "sql",
        volatility: "immutable",
        securityDefiner: false,
        comment: "Adds one",
      });
      expect(addOne[0]!.definition).toContain("CREATE OR REPLACE FUNCTION public.add_one");
      expect(addOne[0]!.definition).toContain("SELECT a + 1");
    });

    it("reads volatility, security and procedures", () => {
      const who = objects.functions.find((f) => f.name === "who")!;
      expect(who).toMatchObject({ volatility: "stable", securityDefiner: true, returns: "text" });
      const procedure = objects.functions.find((f) => f.name === "do_nothing")!;
      expect(procedure).toMatchObject({
        kind: "procedure",
        returns: null,
        arguments: "x integer",
      });
    });

    it("leaves out functions of an extension and the ones a range type creates for itself", () => {
      expect(objects.functions.every((f) => f.schema === "public")).toBe(true);
      expect(objects.functions.map((f) => f.name)).not.toContain("similarity");
      expect(objects.functions.map((f) => f.name).sort()).toEqual([
        "add_one",
        "add_one",
        "do_nothing",
        "touch",
        "who",
      ]);
    });
  });

  describe("triggers", () => {
    const trigger = (name: string) => objects.triggers.find((t) => t.name === name)!;

    it("decodes timing, events, level, function and state", () => {
      expect(trigger("gadgets_touch")).toMatchObject({
        table: "gadgets",
        timing: "before",
        events: ["insert", "update"],
        level: "row",
        function: "public.touch",
        state: "enabled",
      });
      expect(trigger("gadgets_stmt")).toMatchObject({
        timing: "after",
        events: ["delete", "truncate"],
        level: "statement",
        state: "disabled",
      });
      expect(trigger("gv_ins")).toMatchObject({
        table: "gadget_view",
        timing: "instead_of",
        events: ["insert"],
      });
      expect(trigger("gadgets_touch").definition).toContain("CREATE TRIGGER gadgets_touch");
    });

    it("hides the triggers that enforce foreign keys, and a partitioned table's copies", () => {
      expect(objects.triggers.map((t) => `${t.table}.${t.name}`).sort()).toEqual([
        "ev.ev_touch",
        "gadget_view.gv_ins",
        "gadgets.gadgets_stmt",
        "gadgets.gadgets_touch",
      ]);
    });
  });

  describe("extensions", () => {
    it("lists installed extensions with version and schema", () => {
      const names = objects.extensions.map((e) => e.name);
      expect(names).toEqual(["pg_trgm", "plpgsql"]);
      expect(objects.extensions.find((e) => e.name === "pg_trgm")).toMatchObject({
        schema: "public",
        comment: expect.stringContaining("trigram") as string,
      });
      expect(objects.extensions.find((e) => e.name === "plpgsql")!.schema).toBe("pg_catalog");
    });
  });

  describe("row-level security", () => {
    it("lists policies with command, kind, roles and expressions", () => {
      const reader = objects.policies.find((p) => p.name === "gadget_reader")!;
      expect(reader).toMatchObject({
        table: "gadgets",
        command: "select",
        permissive: true,
        roles: [db.connection.username],
        withCheck: null,
      });
      expect(reader.using).toContain("id > 0");

      const limit = objects.policies.find((p) => p.name === "gadget_limit")!;
      expect(limit).toMatchObject({ command: "update", permissive: false, roles: ["public"] });
      expect(limit.using).toContain("id > 0");
      expect(limit.withCheck).toContain("id < 1000");
    });

    it("lists tables with row security on, forced or not, even without policies", () => {
      expect(objects.rowSecurity).toEqual([
        { schema: "public", table: "gadgets", forced: false },
        { schema: "public", table: "products", forced: true },
      ]);
    });
  });

  it("never returns anything from the system schemas", () => {
    const schemas = [
      ...objects.views,
      ...objects.types,
      ...objects.sequences,
      ...objects.functions,
      ...objects.triggers,
      ...objects.policies,
    ].map((o) => o.schema);
    expect(schemas.filter((s) => s.startsWith("pg_") || s === "information_schema")).toEqual([]);
  });

  it("answers the same twice (sorted, stable)", async () => {
    expect(await adapter.getObjects()).toEqual(objects);
  });
});
