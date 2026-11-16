/**
 * The adapter CONTRACT TESTS: one set of behavioural checks that every
 * `DatabaseAdapter` implementation must pass.
 *
 * The mock adapter and the real PostgreSQL adapter run exactly the same suite,
 * which is what guarantees they are interchangeable. If the mock ever behaves
 * differently from PostgreSQL, tests built on the mock would give false
 * confidence; this suite makes that drift fail loudly.
 *
 * The suite expects the adapter to serve the sample shop database
 * (users, products, orders, order_items): the mock's built-in data, or
 * examples/ecommerce.sql loaded into a real PostgreSQL database. A real
 * database may contain EXTRA tables, indexes and relationships; the suite only
 * asserts what the shared core must contain.
 *
 * This file imports `vitest`, so it is its own entry point
 * (`@datacanvas/database-core/contract`) and is NOT re-exported from
 * `testing/index.ts`: code that only wants the mock must not load a test runner.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DatabaseAdapter } from "../adapter.js";
import { encodeRowsCursor } from "../rows.js";

/** Calls that need an open connection, used to check "not connected" behaviour. */
const dataCalls: Array<[string, (a: DatabaseAdapter) => Promise<unknown>]> = [
  ["getSchemas", (a) => a.getSchemas()],
  ["getTables", (a) => a.getTables("public")],
  ["getColumns", (a) => a.getColumns("public", "users")],
  ["getConstraints", (a) => a.getConstraints("public", "users")],
  ["getIndexes", (a) => a.getIndexes("public", "users")],
  ["getTablesDetails", (a) => a.getTablesDetails([{ schema: "public", name: "users" }])],
  ["searchObjects", (a) => a.searchObjects("user", 5)],
  ["getRelationships", (a) => a.getRelationships()],
  [
    "getRows",
    (a) =>
      a.getRows(
        { schema: "public", name: "users" },
        { pageSize: 10, cursor: null, revealColumns: [] },
      ),
  ],
];

/** Assert a promise rejects with a DatabaseError carrying exactly this code. */
async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toMatchObject({ name: "DatabaseError", code });
}

export function describeAdapterContract(label: string, createAdapter: () => DatabaseAdapter): void {
  describe(`${label}: DatabaseAdapter contract`, () => {
    describe("connection lifecycle", () => {
      it.each(dataCalls)("%s rejects with not_connected before connect()", async (_name, call) => {
        await expectCode(call(createAdapter()), "not_connected");
      });

      it("connect() can be called twice, and disconnect() can be called repeatedly", async () => {
        const adapter = createAdapter();
        await adapter.connect();
        await adapter.connect();
        await adapter.disconnect();
        await adapter.disconnect();
      });

      it("disconnect() is safe when never connected", async () => {
        await expect(createAdapter().disconnect()).resolves.toBeUndefined();
      });

      it("data calls reject with not_connected after disconnect(), and work again after reconnecting", async () => {
        const adapter = createAdapter();
        await adapter.connect();
        await adapter.disconnect();
        await expectCode(adapter.getSchemas(), "not_connected");
        await adapter.connect();
        await expect(adapter.getSchemas()).resolves.toBeInstanceOf(Array);
        await adapter.disconnect();
      });

      it("testConnection() works without connect() and does not leave the adapter connected", async () => {
        const adapter = createAdapter();
        await expect(adapter.testConnection()).resolves.toBeUndefined();
        await expectCode(adapter.getSchemas(), "not_connected");
      });
    });

    describe("structure of the sample shop database", () => {
      let adapter: DatabaseAdapter;
      beforeAll(async () => {
        adapter = createAdapter();
        await adapter.connect();
      });
      afterAll(async () => {
        await adapter.disconnect();
      });

      it("lists the public schema", async () => {
        const names = (await adapter.getSchemas()).map((s) => s.name);
        expect(names).toContain("public");
      });

      it("lists the shop tables, sorted by name, with the right kind", async () => {
        const tables = await adapter.getTables("public");
        const names = tables.map((t) => t.name);
        expect(names).toEqual([...names].sort());
        for (const name of ["users", "products", "orders", "order_items"]) {
          expect(tables.find((t) => t.name === name)).toMatchObject({
            schema: "public",
            name,
            kind: "table",
          });
        }
        expect(tables.find((t) => t.name === "active_users")).toMatchObject({ kind: "view" });
      });

      it("lists a materialized view in its own schema", async () => {
        const tables = await adapter.getTables("analytics");
        expect(tables.find((t) => t.name === "daily_sales")).toMatchObject({
          kind: "materialized_view",
        });
      });

      it("describes the columns of users, in order", async () => {
        const columns = await adapter.getColumns("public", "users");
        // Only the first four columns: a real database may have added more after them.
        expect(columns.slice(0, 4).map((c) => [c.name, c.dataType, c.nullable])).toEqual([
          ["id", "integer", false],
          ["email", "text", false],
          ["full_name", "text", true],
          ["created_at", "timestamp with time zone", false],
        ]);
        expect(columns.map((c) => c.ordinalPosition)).toEqual(columns.map((_c, i) => i + 1));
        expect(columns.find((c) => c.name === "created_at")?.defaultValue).toBe("now()");
        expect(columns.find((c) => c.name === "full_name")?.defaultValue).toBeNull();
      });

      it("reports defaults as SQL text", async () => {
        const columns = await adapter.getColumns("public", "orders");
        expect(columns.find((c) => c.name === "status")?.defaultValue).toBe("'pending'::text");
      });

      it("describes the constraints of order_items by kind and name", async () => {
        const constraints = await adapter.getConstraints("public", "order_items");
        const byName = (name: string) => constraints.find((c) => c.name === name);
        expect(byName("order_items_pkey")).toMatchObject({ kind: "primary_key", columns: ["id"] });
        expect(byName("order_items_order_id_fkey")).toMatchObject({
          kind: "foreign_key",
          columns: ["order_id"],
        });
        expect(byName("order_items_product_id_fkey")).toMatchObject({ kind: "foreign_key" });
        expect(byName("order_items_quantity_check")).toMatchObject({
          kind: "check",
          columns: ["quantity"],
        });
      });

      it("reports unique constraints", async () => {
        const constraints = await adapter.getConstraints("public", "users");
        expect(constraints.find((c) => c.name === "users_email_key")).toMatchObject({
          kind: "unique",
          columns: ["email"],
        });
      });

      it("returns no constraints for a view", async () => {
        await expect(adapter.getConstraints("public", "active_users")).resolves.toEqual([]);
      });

      it("describes the indexes of orders", async () => {
        const indexes = await adapter.getIndexes("public", "orders");
        expect(indexes.find((i) => i.name === "orders_pkey")).toMatchObject({
          columns: ["id"],
          unique: true,
          primary: true,
          method: "btree",
        });
        expect(indexes.find((i) => i.name === "orders_user_id_idx")).toMatchObject({
          columns: ["user_id"],
          unique: false,
          primary: false,
          method: "btree",
        });
      });

      it("lists the three confirmed foreign keys of the shop with exact details", async () => {
        const relationships = await adapter.getRelationships();
        const byName = (name: string) => relationships.find((r) => r.name === name);

        expect(byName("orders_user_id_fkey")).toEqual({
          name: "orders_user_id_fkey",
          source: { schema: "public", table: "orders", columns: ["user_id"] },
          target: { schema: "public", table: "users", columns: ["id"] },
          cardinality: "many-to-one",
          onDelete: "no_action",
          onUpdate: "no_action",
        });
        expect(byName("order_items_order_id_fkey")).toMatchObject({
          source: { table: "order_items", columns: ["order_id"] },
          target: { table: "orders", columns: ["id"] },
          cardinality: "many-to-one",
          onDelete: "cascade",
        });
        expect(byName("order_items_product_id_fkey")).toMatchObject({
          target: { table: "products", columns: ["id"] },
          onDelete: "restrict",
        });
      });

      it("only reports relationships whose columns really exist", async () => {
        for (const rel of await adapter.getRelationships()) {
          for (const end of [rel.source, rel.target]) {
            const known = (await adapter.getColumns(end.schema, end.table)).map((c) => c.name);
            for (const column of end.columns) expect(known).toContain(column);
          }
          expect(rel.source.columns).toHaveLength(rel.target.columns.length);
        }
      });

      describe("getTablesDetails (bulk)", () => {
        const refs = [
          { schema: "public", name: "orders" },
          { schema: "public", name: "users" },
          { schema: "public", name: "active_users" }, // a view
        ];

        it("returns exactly what the per-table methods return", async () => {
          const bulk = await adapter.getTablesDetails(refs);
          expect(bulk).toHaveLength(3);
          const listed = await adapter.getTables("public");
          for (const entry of bulk) {
            const { schema, name } = entry.table;
            expect(entry.table).toEqual(listed.find((t) => t.name === name));
            expect(entry.columns).toEqual(await adapter.getColumns(schema, name));
            expect(entry.constraints).toEqual(await adapter.getConstraints(schema, name));
            expect(entry.indexes).toEqual(await adapter.getIndexes(schema, name));
          }
        });

        it("follows the requested order and collapses duplicates", async () => {
          const bulk = await adapter.getTablesDetails([refs[1]!, refs[0]!, refs[1]!]);
          expect(bulk.map((e) => e.table.name)).toEqual(["users", "orders"]);
        });

        it("returns an empty array for no tables", async () => {
          await expect(adapter.getTablesDetails([])).resolves.toEqual([]);
        });

        it("fails as a whole with not_found if any table does not exist", async () => {
          await expectCode(
            adapter.getTablesDetails([refs[0]!, { schema: "public", name: "no_such_table" }]),
            "not_found",
          );
          await expectCode(
            adapter.getTablesDetails([{ schema: "nope", name: "users" }]),
            "not_found",
          );
        });

        it("handles tables from several schemas in one call", async () => {
          const bulk = await adapter.getTablesDetails([
            refs[0]!,
            { schema: "analytics", name: "daily_sales" },
          ]);
          expect(bulk.map((e) => `${e.table.schema}.${e.table.name}`)).toEqual([
            "public.orders",
            "analytics.daily_sales",
          ]);
        });
      });

      describe("searchObjects", () => {
        const names = (hits: Awaited<ReturnType<DatabaseAdapter["searchObjects"]>>, kind: string) =>
          hits
            .filter((h) => h.kind === kind)
            .map((h) => `${h.schema}.${h.table}${h.column ? `.${h.column}` : ""}`);

        it("finds tables by part of their name, case-insensitively, with the right kind", async () => {
          const hits = await adapter.searchObjects("ORD", 20);
          expect(names(hits, "table")).toEqual(
            expect.arrayContaining(["public.orders", "public.order_items"]),
          );
          for (const hit of hits.filter((h) => h.kind !== "column")) {
            expect(hit.column).toBeNull();
            expect(hit.dataType).toBeNull();
          }
        });

        it("finds views and materialized views", async () => {
          expect(names(await adapter.searchObjects("active_users", 5), "view")).toEqual([
            "public.active_users",
          ]);
          expect(names(await adapter.searchObjects("daily_sales", 5), "materialized_view")).toEqual(
            ["analytics.daily_sales"],
          );
        });

        it("finds columns, with their type and the table they belong to", async () => {
          const hits = await adapter.searchObjects("email", 20);
          expect(hits).toEqual(
            expect.arrayContaining([
              {
                kind: "column",
                schema: "public",
                table: "users",
                column: "email",
                dataType: "text",
              },
            ]),
          );
        });

        it("ranks an exact name before names that merely contain it", async () => {
          const tableHits = (await adapter.searchObjects("users", 20)).filter(
            (h) => h.kind !== "column",
          );
          expect(tableHits[0]).toMatchObject({ schema: "public", table: "users" });
          expect(tableHits.length).toBeGreaterThan(1); // active_users etc. follow
        });

        it("lists table hits before column hits", async () => {
          const kinds = (await adapter.searchObjects("user", 20)).map((h) => h.kind === "column");
          expect(kinds).toEqual([...kinds].sort((a, b) => Number(a) - Number(b)));
        });

        it("returns at most `limit` table hits and `limit` column hits", async () => {
          const hits = await adapter.searchObjects("e", 3);
          expect(hits.filter((h) => h.kind === "column").length).toBeLessThanOrEqual(3);
          expect(hits.filter((h) => h.kind !== "column").length).toBeLessThanOrEqual(3);
          expect(hits.length).toBeGreaterThan(0);
        });

        it("returns nothing for a blank query or a name that does not exist", async () => {
          await expect(adapter.searchObjects("", 10)).resolves.toEqual([]);
          await expect(adapter.searchObjects("   ", 10)).resolves.toEqual([]);
          await expect(adapter.searchObjects("zzz_no_such_name_zzz", 10)).resolves.toEqual([]);
        });

        it("treats % and _ as ordinary characters, never as wildcards", async () => {
          await expect(adapter.searchObjects("%", 50)).resolves.toEqual([]);
          const underscore = await adapter.searchObjects("_", 50);
          expect(underscore.length).toBeGreaterThan(0);
          for (const hit of underscore) expect(hit.column ?? hit.table).toContain("_");
        });

        it("never returns system schemas", async () => {
          const hits = await adapter.searchObjects("pg_", 50);
          for (const hit of hits) {
            expect(hit.schema.startsWith("pg_")).toBe(false);
            expect(hit.schema).not.toBe("information_schema");
          }
        });
      });

      describe("getRows", () => {
        const users = { schema: "public", name: "users" };
        const first = { pageSize: 50, cursor: null, revealColumns: [] };

        it("reads the rows of users in primary-key order, every value as text", async () => {
          const page = await adapter.getRows(users, first);
          expect(page.columns.map((c) => c.name)).toEqual([
            "id",
            "email",
            "full_name",
            "created_at",
          ]);
          expect(page.columns.some((c) => c.masked)).toBe(false);
          expect(page.order).toEqual({ kind: "primary_key", columns: ["id"] });
          expect(page.rows.map((row) => row[0]!.value)).toEqual(["1", "2", "3"]);
          expect(page.rows.map((row) => row[1]!.value)).toEqual([
            "a@x.test",
            "b@x.test",
            "c@x.test",
          ]);
          expect(page).toMatchObject({
            nextCursor: null,
            hiddenColumns: 0,
            cutBySize: false,
            offsetCapped: false,
          });
          for (const cell of page.rows.flat()) {
            expect(cell.value === null || typeof cell.value === "string").toBe(true);
            expect(cell.truncated).toBe(false);
          }
        });

        it("keeps SQL NULL as null, not as the empty string", async () => {
          const page = await adapter.getRows(users, first);
          expect(page.rows[0]![2]).toEqual({ value: null, truncated: false });
        });

        it("pages by the key: a cursor continues after the last row, and the last page has none", async () => {
          const one = await adapter.getRows(users, { ...first, pageSize: 2 });
          expect(one.rows.map((row) => row[0]!.value)).toEqual(["1", "2"]);
          expect(one.nextCursor).not.toBeNull();

          const two = await adapter.getRows(users, {
            ...first,
            pageSize: 2,
            cursor: one.nextCursor,
          });
          expect(two.rows.map((row) => row[0]!.value)).toEqual(["3"]);
          expect(two.nextCursor).toBeNull();
        });

        it("walks the whole table one row at a time without repeating or skipping a row", async () => {
          const seen: string[] = [];
          let cursor: string | null = null;
          for (let guard = 0; guard < 10; guard += 1) {
            const page = await adapter.getRows(users, { pageSize: 1, cursor, revealColumns: [] });
            seen.push(...page.rows.map((row) => row[0]!.value!));
            cursor = page.nextCursor;
            if (cursor === null) break;
          }
          expect(seen).toEqual(["1", "2", "3"]);
        });

        it("gives an empty page for a table with no rows, with its columns", async () => {
          const page = await adapter.getRows({ schema: "public", name: "orders" }, first);
          expect(page.rows).toEqual([]);
          expect(page.nextCursor).toBeNull();
          expect(page.columns.map((c) => c.name)).toContain("user_id");
        });

        it("refuses a page size or a cursor that is not valid, with invalid_request", async () => {
          for (const options of [
            { ...first, pageSize: 0 },
            { ...first, pageSize: 201 },
            { ...first, pageSize: 1.5 },
            { ...first, cursor: "not a cursor!" },
            // a position that belongs to a table without a key, offered to a table with one
            { ...first, cursor: encodeRowsCursor({ kind: "offset", offset: 1 }) },
            // a key of the wrong length
            { ...first, cursor: encodeRowsCursor({ kind: "keyset", values: ["1", "2"] }) },
          ]) {
            await expectCode(adapter.getRows(users, options), "invalid_request");
          }
        });

        it("rejects an unknown schema or table with not_found", async () => {
          await expectCode(
            adapter.getRows({ schema: "public", name: "no_such_table" }, first),
            "not_found",
          );
          await expectCode(
            adapter.getRows({ schema: "no_such_schema", name: "users" }, first),
            "not_found",
          );
        });

        it("returns plain JSON-safe data", async () => {
          const page = await adapter.getRows(users, { ...first, pageSize: 2 });
          expect(JSON.parse(JSON.stringify(page))).toEqual(page);
        });
      });

      it("rejects an unknown schema or table with not_found", async () => {
        await expectCode(adapter.getTables("no_such_schema"), "not_found");
        await expectCode(adapter.getColumns("public", "no_such_table"), "not_found");
        await expectCode(adapter.getConstraints("public", "no_such_table"), "not_found");
        await expectCode(adapter.getIndexes("public", "no_such_table"), "not_found");
        await expectCode(adapter.getColumns("no_such_schema", "users"), "not_found");
      });

      it("returns plain JSON-safe data (nothing is lost by a JSON round trip)", async () => {
        const results = [
          await adapter.getSchemas(),
          await adapter.getTables("public"),
          await adapter.getColumns("public", "users"),
          await adapter.getConstraints("public", "orders"),
          await adapter.getIndexes("public", "orders"),
          await adapter.getRelationships(),
          await adapter.getTablesDetails([{ schema: "public", name: "orders" }]),
          await adapter.searchObjects("order", 10),
        ];
        for (const result of results) {
          expect(JSON.parse(JSON.stringify(result))).toEqual(result);
        }
      });
    });
  });
}
