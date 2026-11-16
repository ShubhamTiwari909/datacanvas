/**
 * The adapter against an awkward schema (examples/odd-schema.sql): names that
 * need quoting, unusual types, tables with no columns or no key, composite,
 * self-referencing and circular foreign keys, inheritance, nested partitions,
 * views of views, expression indexes.
 *
 * Real databases contain all of this; the tidy sample shop does not. Each test
 * pins down what DataCanvas does with one awkward case, so a change in
 * behaviour is a decision, not an accident.
 *
 * Skipped unless DATACANVAS_TEST_PG_URL is set (see the integration test).
 * Runs in its own throwaway database.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseError, type RelationshipInfo } from "@datacanvas/database-core";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresAdapter } from "./postgres.adapter.js";
import { createTestDatabase, testDatabaseUrl, type TestDatabase } from "./testing/index.js";

const oddSql = readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../examples/odd-schema.sql"),
  "utf8",
);

describe.skipIf(!testDatabaseUrl())("PostgresAdapter against an awkward schema", () => {
  let db: TestDatabase;
  let adapter: PostgresAdapter;
  let relationships: RelationshipInfo[];

  const MIXED = "Mixed Case-Schema";
  const UNI = "ünïcode_schéma";
  const LONG_NAME = "a".repeat(63);

  const tableNames = async (schema: string): Promise<string[]> =>
    (await adapter.getTables(schema)).map((t) => t.name);
  const relBetween = (
    sourceName: string,
    targetName: string,
    sourceSchema = "public",
  ): RelationshipInfo[] =>
    relationships.filter(
      (r) =>
        r.source.table === sourceName &&
        r.target.table === targetName &&
        r.source.schema === sourceSchema,
    );

  beforeAll(async () => {
    db = await createTestDatabase();
    const { host, port, username, password } = db.connection;
    const client = new pg.Client({ host, port, user: username, password, database: db.dbName });
    await client.connect();
    try {
      await client.query(oddSql);
    } finally {
      await client.end();
    }
    adapter = new PostgresAdapter(db.connection);
    await adapter.connect();
    relationships = await adapter.getRelationships();
  }, 60_000);

  afterAll(async () => {
    await adapter?.disconnect();
    await db?.dispose();
  }, 60_000);

  describe("names", () => {
    it("lists schemas with spaces, capitals and accents, and never temporary or system ones", async () => {
      const names = (await adapter.getSchemas()).map((s) => s.name);
      expect(names).toEqual(expect.arrayContaining([MIXED, UNI, "other", "public"]));
      expect(names.some((n) => n.startsWith("pg_") || n === "information_schema")).toBe(false);
    });

    it("returns awkward table names exactly as they are", async () => {
      const names = await tableNames("public");
      for (const name of ["select", "a.b", "; DROP TABLE users; --", "🚀", LONG_NAME]) {
        expect(names, name).toContain(name);
      }
      expect(await tableNames(MIXED)).toEqual(expect.arrayContaining(["Order Items", "Odd View"]));
      expect(await tableNames(UNI)).toContain("ñandú_tabla");
    });

    it("does not list temporary tables", async () => {
      expect(await tableNames("public")).not.toContain("temp_hidden");
    });

    it("keeps the same table name in two schemas apart", async () => {
      expect(await tableNames("public")).toContain("shared_name");
      expect(await tableNames("other")).toContain("shared_name");
      expect(relBetween("shared_name", "shared_name", "other")).toHaveLength(1);
    });

    it("returns column names with quotes, spaces, symbols and non-Latin letters", async () => {
      const columns = await adapter.getColumns(MIXED, "Order Items");
      expect(columns.map((c) => c.name)).toEqual([
        "ID",
        "Unit Price ($)",
        'weird"quote',
        "select",
        "день",
      ]);
      expect((await adapter.getColumns(UNI, "ñandú_tabla")).map((c) => c.name)).toContain("名前");
    });

    it("returns comments verbatim: newlines, quotes, HTML-looking text and emoji", async () => {
      const [table] = (await adapter.getTables(MIXED)).filter((t) => t.name === "Order Items");
      expect(table?.comment).toBe("Line 1\nLine 2 with \"quotes\", 'apostrophes' and 日本語 🚀");
      const [id] = await adapter.getColumns(MIXED, "Order Items");
      expect(id?.comment).toBe("The key; <b>not html</b> & so on");
    });

    it("loads details for tables whose names need quoting", async () => {
      const entries = await adapter.getTablesDetails([
        { schema: MIXED, name: "Order Items" },
        { schema: "public", name: "; DROP TABLE users; --" },
        { schema: "public", name: "select" },
        { schema: UNI, name: "ñandú_tabla" },
      ]);
      expect(entries).toHaveLength(4);
      // The "attack" name is only a name: the users table of the sample shop is untouched.
      expect(await tableNames("public")).toContain("users");
    });

    it("finds objects with awkward names by search", async () => {
      const hit = async (q: string) =>
        (await adapter.searchObjects(q, 10)).map(
          (h) => `${h.schema}.${h.table}${h.column ? `.${h.column}` : ""}`,
        );
      expect(await hit("drop table")).toContain("public.; DROP TABLE users; --");
      expect(await hit("🚀")).toContain("public.🚀");
      expect(await hit("名前")).toContain(`${UNI}.ñandú_tabla.名前`);
      expect(await hit("ñandú")).toContain(`${UNI}.ñandú_tabla`);
    });
  });

  describe("types and columns", () => {
    it("prints enums, domains, composites, arrays, ranges, json and network types", async () => {
      const types = Object.fromEntries(
        (await adapter.getColumns("public", "typed")).map((c) => [c.name, c.dataType]),
      );
      expect(types).toMatchObject({
        id: "bigint",
        feeling: "mood",
        qty: "positive_int",
        contact: "email_text",
        home: "address_t",
        tags: "text[]",
        matrix: "integer[]",
        window_: "tstzrange",
        payload: "jsonb",
        doubled: "integer",
        ip: "inet",
        nothing_special: "character varying(40)",
      });
    });

    it("returns defaults as SQL text, including generated and identity columns", async () => {
      const columns = Object.fromEntries(
        (await adapter.getColumns("public", "typed")).map((c) => [c.name, c]),
      );
      expect(columns.feeling?.defaultValue).toContain("'ok'");
      expect(columns.payload?.defaultValue).toContain("jsonb");
      expect(columns.feeling?.nullable).toBe(false);
    });

    it("handles a table with no columns", async () => {
      expect(await adapter.getColumns("public", "no_columns")).toEqual([]);
      const [entry] = await adapter.getTablesDetails([{ schema: "public", name: "no_columns" }]);
      expect(entry?.columns).toEqual([]);
    });

    it("handles a table with 301 columns, in order", async () => {
      const columns = await adapter.getColumns("public", "wide");
      expect(columns).toHaveLength(301);
      expect(columns.map((c) => c.ordinalPosition)).toEqual(columns.map((_c, i) => i + 1));
    });

    it("reports a table without a primary key as having none", async () => {
      const constraints = await adapter.getConstraints("public", "no_primary_key");
      expect(constraints.filter((c) => c.kind === "primary_key")).toEqual([]);
    });

    it("lists unlogged tables like any other", async () => {
      expect(await tableNames("public")).toContain("unlogged_t");
    });
  });

  describe("foreign keys", () => {
    it("keeps both columns of a composite key", () => {
      const [rel] = relBetween("fk_composite", "fk_parent");
      expect(rel).toBeDefined();
      expect(rel?.source.columns).toEqual(["pa", "pb"]);
      expect(rel?.target.columns).toEqual(["a", "b"]);
      expect(rel?.onDelete).toBe("cascade");
      expect(rel?.onUpdate).toBe("restrict");
    });

    it("reports a self-reference once, with the same table on both ends", () => {
      const rels = relBetween("fk_self", "fk_self");
      expect(rels).toHaveLength(1);
      expect(rels[0]?.onDelete).toBe("set_null");
    });

    it("follows a foreign key to a unique column that is not the primary key (even if deferrable)", () => {
      const [rel] = relBetween("fk_by_code", "fk_unique_target");
      expect(rel?.source.columns).toEqual(["code"]);
      expect(rel?.target.columns).toEqual(["code"]);
    });

    it("reports every edge of a circular reference", () => {
      expect(relBetween("circle_a", "circle_b")).toHaveLength(1);
      expect(relBetween("circle_b", "circle_c")).toHaveLength(1);
      expect(relBetween("circle_c", "circle_a")).toHaveLength(1);
    });

    it("links tables across schemas with awkward names", () => {
      expect(relBetween("cross_ref", "Order Items", UNI)).toHaveLength(1);
      expect(relBetween("cross_ref", "select", UNI)).toHaveLength(1);
    });

    it("calls a foreign key that is also the primary key one-to-one", () => {
      expect(relBetween("one_to_one", "fk_unique_target")[0]?.cardinality).toBe("one-to-one");
    });

    it("does not invent relationships for inheritance", () => {
      expect(
        relationships.some((r) => r.source.table === "dogs" || r.target.table === "dogs"),
      ).toBe(false);
    });
  });

  describe("inheritance and partitions", () => {
    it("lists a child table of an inheritance tree as its own table", async () => {
      const names = await tableNames("public");
      expect(names).toEqual(expect.arrayContaining(["animals", "dogs"]));
    });

    it("lists a partitioned table once and hides every partition, at every level", async () => {
      const names = await tableNames("public");
      expect(names).toContain("measurements");
      expect(names).toContain("hash_parted");
      for (const hidden of [
        "measurements_eu",
        "measurements_eu_2025",
        "measurements_us",
        "hash_parted_0",
        "hash_parted_1",
      ]) {
        expect(names, hidden).not.toContain(hidden);
      }
    });

    it("can still describe a partition when asked for it by name", async () => {
      const [entry] = await adapter.getTablesDetails([
        { schema: "public", name: "measurements_eu_2025" },
      ]);
      expect(entry?.table.name).toBe("measurements_eu_2025");
    });

    it("reports a foreign key to a partitioned table once, not once per partition", () => {
      expect(relBetween("measurement_notes", "measurements")).toHaveLength(1);
      expect(relBetween("measurement_notes", "measurements")[0]?.source.columns).toEqual([
        "m_id",
        "m_region",
        "m_taken",
      ]);
      expect(relationships.some((r) => /^measurements_/.test(r.target.table))).toBe(false);
    });
  });

  describe("views and indexes", () => {
    it("tells tables, views and materialized views apart", async () => {
      const kinds = Object.fromEntries(
        (await adapter.getTables("public")).map((t) => [t.name, t.kind]),
      );
      expect(kinds).toMatchObject({
        v_typed: "view",
        v_of_view: "view",
        mv_counts: "materialized_view",
        typed: "table",
      });
      expect((await adapter.getTables("public")).find((t) => t.name === "v_typed")?.comment).toBe(
        "A view with a comment",
      );
    });

    it("describes the columns of a view whose columns are aliased", async () => {
      expect((await adapter.getColumns(MIXED, "Odd View")).map((c) => c.name)).toEqual(["My ID"]);
    });

    it("reports expression, partial, covering, GIN and BRIN indexes", async () => {
      const indexes = Object.fromEntries(
        (await adapter.getIndexes("public", "typed")).map((i) => [i.name, i]),
      );
      expect(indexes.typed_expr_idx?.columns.join(",")).toContain("lower(contact");
      expect(indexes.typed_gin_idx?.method).toBe("gin");
      expect(indexes.typed_brin_idx?.method).toBe("brin");
      expect(indexes.typed_partial_idx?.definition).toContain("WHERE");
      expect(indexes.typed_include_idx?.definition).toContain("INCLUDE");
      expect(indexes.typed_multi_unique?.unique).toBe(true);
      expect(indexes.typed_multi_unique?.columns).toEqual(["feeling", "qty"]);
      expect(indexes.typed_pkey?.primary).toBe(true);
    });
  });

  describe("foreign tables (postgres_fdw)", () => {
    // Needs the contrib extension; when the server lacks it, the checks below
    // are skipped at run time and say so.
    let available = false;

    beforeAll(async () => {
      const { host, port, username, password } = db.connection;
      const client = new pg.Client({ host, port, user: username, password, database: db.dbName });
      await client.connect();
      try {
        await client.query("CREATE EXTENSION postgres_fdw");
        await client.query(
          `CREATE SERVER loopback FOREIGN DATA WRAPPER postgres_fdw OPTIONS (host '${host}', port '${port}', dbname '${db.dbName}')`,
        );
        await client.query(
          "CREATE FOREIGN TABLE public.remote_users (id integer, email text) SERVER loopback OPTIONS (table_name 'users')",
        );
        available = true;
      } catch {
        available = false;
      } finally {
        await client.end();
      }
    });

    it("lists a foreign table as its own kind, alongside ordinary tables", async (context) => {
      if (!available) context.skip();
      const tables = await adapter.getTables("public");
      expect(tables.find((t) => t.name === "remote_users")?.kind).toBe("foreign_table");
      expect(tables.find((t) => t.name === "users")?.kind).toBe("table");
    });

    it("reports an unknown row estimate for a foreign table that was never analysed", async (context) => {
      if (!available) context.skip();
      const table = (await adapter.getTables("public")).find((t) => t.name === "remote_users");
      expect(table?.estimatedRowCount).toBeNull();
    });

    it("reads a foreign table's columns and details like a table's, with no keys or indexes", async (context) => {
      if (!available) context.skip();
      const columns = await adapter.getColumns("public", "remote_users");
      expect(columns.map((c) => c.name)).toEqual(["id", "email"]);
      const [entry] = await adapter.getTablesDetails([{ schema: "public", name: "remote_users" }]);
      expect(entry?.table.kind).toBe("foreign_table");
      expect(entry?.columns).toHaveLength(2);
      expect(entry?.indexes).toEqual([]);
      expect(entry?.constraints.filter((c) => c.kind === "primary_key")).toEqual([]);
    });

    it("finds a foreign table by search and keeps relationships and schemas working", async (context) => {
      if (!available) context.skip();
      const hits = await adapter.searchObjects("remote", 5);
      expect(hits.find((h) => h.table === "remote_users" && h.column === null)?.kind).toBe(
        "foreign_table",
      );
      expect(await adapter.getSchemas()).not.toHaveLength(0);
      expect(await adapter.getRelationships()).toBeInstanceOf(Array);
    });
  });

  describe("reading rows", () => {
    it("reads the rows of every table, view and materialized view of the awkward schema, whatever its name", async () => {
      const read: string[] = [];
      for (const schema of await adapter.getSchemas()) {
        for (const table of await adapter.getTables(schema.name)) {
          const ref = { schema: schema.name, name: table.name };
          const options = { pageSize: 5, cursor: null, revealColumns: [] };
          if (table.kind === "foreign_table") {
            await expect(adapter.getRows(ref, options)).rejects.toMatchObject({
              code: "not_supported",
            });
            continue;
          }
          const page = await adapter.getRows(ref, options);
          // Whatever the table looks like, the page is well formed and within every limit.
          expect(page.columns.length).toBeLessThanOrEqual(100);
          for (const row of page.rows) expect(row).toHaveLength(page.columns.length);
          expect(page.rows.length).toBeLessThanOrEqual(5);
          read.push(`${schema.name}.${table.name}`);
        }
      }
      // Guard against a hollow loop: the fixture really has many awkward relations.
      expect(read.length).toBeGreaterThan(20);
    });
  });

  describe("missing things", () => {
    it("answers not_found for a table that does not exist, whatever its name looks like", async () => {
      await expect(adapter.getColumns("public", "nope")).rejects.toMatchObject({
        code: "not_found",
      });
      await expect(
        adapter.getTablesDetails([{ schema: "public", name: "temp_hidden" }]),
      ).rejects.toBeInstanceOf(DatabaseError);
    });
  });
});
