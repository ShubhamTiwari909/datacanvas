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

/** Calls that need an open connection, used to check "not connected" behaviour. */
const dataCalls: Array<[string, (a: DatabaseAdapter) => Promise<unknown>]> = [
  ["getSchemas", (a) => a.getSchemas()],
  ["getTables", (a) => a.getTables("public")],
  ["getColumns", (a) => a.getColumns("public", "users")],
  ["getConstraints", (a) => a.getConstraints("public", "users")],
  ["getIndexes", (a) => a.getIndexes("public", "users")],
  ["getRelationships", (a) => a.getRelationships()],
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
        ];
        for (const result of results) {
          expect(JSON.parse(JSON.stringify(result))).toEqual(result);
        }
      });
    });
  });
}
