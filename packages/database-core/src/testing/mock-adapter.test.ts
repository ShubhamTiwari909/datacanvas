import { beforeEach, describe, expect, it } from "vitest";
import type { DatabaseAdapter } from "../adapter.js";
import { createEcommerceData, MockDatabaseAdapter } from "./index.js";

describe("MockDatabaseAdapter", () => {
  let adapter: DatabaseAdapter; // typed as the INTERFACE: proves the mock satisfies it

  beforeEach(async () => {
    adapter = new MockDatabaseAdapter();
    await adapter.connect();
  });

  describe("connection lifecycle", () => {
    it("rejects every data method with not_connected before connect()", async () => {
      const fresh = new MockDatabaseAdapter();
      const calls = [
        () => fresh.getSchemas(),
        () => fresh.getTables("public"),
        () => fresh.getColumns("public", "users"),
        () => fresh.getConstraints("public", "users"),
        () => fresh.getIndexes("public", "users"),
        () => fresh.getRelationships(),
      ];
      for (const call of calls) {
        await expect(call()).rejects.toMatchObject({ code: "not_connected" });
      }
    });

    it("connect() is idempotent and disconnect() is safe to repeat", async () => {
      await adapter.connect();
      await adapter.disconnect();
      await adapter.disconnect();
      await expect(adapter.getSchemas()).rejects.toMatchObject({ code: "not_connected" });
      await adapter.connect();
      await expect(adapter.getSchemas()).resolves.toHaveLength(2);
    });

    it("testConnection() works without connect() and does not change state", async () => {
      const fresh = new MockDatabaseAdapter();
      await expect(fresh.testConnection()).resolves.toBeUndefined();
      await expect(fresh.getSchemas()).rejects.toMatchObject({ code: "not_connected" });
    });

    it("can be told to fail like a real database would", async () => {
      const failing = new MockDatabaseAdapter({ failConnectWith: "authentication_failed" });
      await expect(failing.connect()).rejects.toMatchObject({ code: "authentication_failed" });
      await expect(failing.testConnection()).rejects.toMatchObject({
        code: "authentication_failed",
      });
    });
  });

  describe("structure", () => {
    it("lists schemas and the tables, view and materialized view in them", async () => {
      expect((await adapter.getSchemas()).map((s) => s.name)).toEqual(["analytics", "public"]);

      const publicTables = await adapter.getTables("public");
      expect(publicTables.map((t) => `${t.name}:${t.kind}`)).toEqual([
        "active_users:view",
        "order_items:table",
        "orders:table",
        "products:table",
        "users:table",
      ]);
      expect((await adapter.getTables("analytics")).map((t) => t.kind)).toEqual([
        "materialized_view",
      ]);
    });

    it("returns columns in definition order with nullability and defaults", async () => {
      const columns = await adapter.getColumns("public", "users");
      expect(columns.map((c) => c.ordinalPosition)).toEqual([1, 2, 3, 4]);
      expect(columns.find((c) => c.name === "full_name")).toMatchObject({ nullable: true });
      expect(columns.find((c) => c.name === "created_at")).toMatchObject({ defaultValue: "now()" });
    });

    it("returns constraints of every kind, and none for views", async () => {
      const kinds = (await adapter.getConstraints("public", "order_items")).map((c) => c.kind);
      expect(kinds).toEqual(expect.arrayContaining(["primary_key", "foreign_key", "check"]));
      expect(await adapter.getConstraints("public", "active_users")).toEqual([]);
    });

    it("returns indexes, marking the primary-key index", async () => {
      const indexes = await adapter.getIndexes("public", "orders");
      expect(indexes.find((i) => i.name === "orders_pkey")).toMatchObject({
        primary: true,
        unique: true,
      });
      expect(indexes.find((i) => i.name === "orders_user_id_idx")).toMatchObject({
        primary: false,
        unique: false,
      });
    });

    it("returns the three confirmed foreign-key relationships", async () => {
      const relationships = await adapter.getRelationships();
      expect(relationships.map((r) => r.name)).toEqual([
        "order_items_order_id_fkey",
        "order_items_product_id_fkey",
        "orders_user_id_fkey",
      ]);
      expect(relationships.find((r) => r.name === "order_items_order_id_fkey")).toMatchObject({
        source: { table: "order_items", columns: ["order_id"] },
        target: { table: "orders", columns: ["id"] },
        cardinality: "many-to-one",
        onDelete: "cascade",
      });
    });
  });

  describe("not_found", () => {
    it("is thrown for an unknown schema or table", async () => {
      await expect(adapter.getTables("nope")).rejects.toMatchObject({ code: "not_found" });
      await expect(adapter.getColumns("public", "nope")).rejects.toMatchObject({
        code: "not_found",
      });
      await expect(adapter.getConstraints("public", "nope")).rejects.toMatchObject({
        code: "not_found",
      });
      await expect(adapter.getIndexes("nope", "users")).rejects.toMatchObject({
        code: "not_found",
      });
    });

    it("is not fooled by names that exist on every JavaScript object", async () => {
      await expect(adapter.getColumns("public", "constructor")).rejects.toMatchObject({
        code: "not_found",
      });
    });
  });

  describe("data integrity of the sample database", () => {
    it("is JSON-safe: a round trip through JSON changes nothing", () => {
      const data = createEcommerceData();
      expect(JSON.parse(JSON.stringify(data))).toEqual(data);
    });

    it("every relationship points at tables and columns that exist", () => {
      const data = createEcommerceData();
      const columnNames = (schema: string, table: string): string[] =>
        (data.columns[`${schema}.${table}`] ?? []).map((c) => c.name);

      for (const rel of data.relationships) {
        for (const end of [rel.source, rel.target]) {
          const known = columnNames(end.schema, end.table);
          expect(known.length).toBeGreaterThan(0);
          for (const column of end.columns) expect(known).toContain(column);
        }
        expect(rel.source.columns).toHaveLength(rel.target.columns.length);
      }
    });

    it("every table has an entry for columns, constraints and indexes", () => {
      const data = createEcommerceData();
      for (const t of data.tables) {
        const key = `${t.schema}.${t.name}`;
        expect(data.columns[key]).toBeDefined();
        expect(data.constraints[key]).toBeDefined();
        expect(data.indexes[key]).toBeDefined();
      }
    });
  });

  it("returns copies: changing a result does not change the database", async () => {
    const first = await adapter.getTables("public");
    first[0]!.name = "tampered";
    const second = await adapter.getTables("public");
    expect(second[0]!.name).toBe("active_users");
  });
});
