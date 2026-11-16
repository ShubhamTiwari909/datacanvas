import type { TableInfo } from "@datacanvas/database-core";
import { describe, expect, it } from "vitest";
import type { SchemaTables } from "./load-all-tables";
import { filterSchemaTables, splitMatch } from "./table-filter";

const table = (schema: string, name: string, kind: TableInfo["kind"] = "table"): TableInfo => ({
  schema,
  name,
  kind,
  comment: null,
  estimatedRowCount: null,
});

const lists: SchemaTables[] = [
  {
    schema: "public",
    tables: [
      table("public", "customers"),
      table("public", "order_items"),
      table("public", "orders"),
      table("public", "users"),
      table("public", "active_users", "view"),
    ],
  },
  { schema: "audit", tables: [table("audit", "log_50%_off"), table("audit", "a_b")] },
  { schema: "billing", tables: [table("billing", "invoices")] },
  { schema: "intl", tables: [table("intl", "Café"), table("intl", "Заказы")] },
];

const names = (query: string) =>
  filterSchemaTables(lists, query).schemas.map((s) => [s.schema, s.tables.map((t) => t.name)]);

describe("filterSchemaTables", () => {
  it("matches case-insensitively anywhere in the name", () => {
    expect(names("ORDER")).toEqual([["public", ["order_items", "orders"]]]);
  });

  it("lists names that start with the text first, otherwise in the tree's order", () => {
    expect(names("users")).toEqual([["public", ["users", "active_users"]]]);
  });

  it("treats %, _ and \\ as ordinary characters", () => {
    expect(names("%")).toEqual([["audit", ["log_50%_off"]]]);
    expect(names("_")).toEqual([
      ["public", ["order_items", "active_users"]],
      ["audit", ["log_50%_off", "a_b"]],
    ]);
    expect(names("a\\b")).toEqual([]);
  });

  it("matches accented and non-Latin names", () => {
    expect(names("café")).toEqual([["intl", ["Café"]]]);
    expect(names("заказ")).toEqual([["intl", ["Заказы"]]]);
  });

  it("drops schemas without a match and counts matches and totals", () => {
    const result = filterSchemaTables(lists, "voice");
    expect(result.schemas.map((s) => s.schema)).toEqual(["billing"]);
    expect(result.matched).toBe(1);
    expect(result.total).toBe(10);
  });

  it("returns everything for empty text", () => {
    const result = filterSchemaTables(lists, "  ");
    expect(result.matched).toBe(10);
    expect(result.schemas).toHaveLength(4);
  });

  it("trims the text", () => {
    expect(names("  invoices ")).toEqual([["billing", ["invoices"]]]);
  });
});

describe("splitMatch", () => {
  it("splits around the first match, keeping the name's own case", () => {
    expect(splitMatch("Order_Items", "items")).toEqual({
      before: "Order_",
      match: "Items",
      after: "",
    });
  });

  it("returns null for no match or empty text", () => {
    expect(splitMatch("users", "zzz")).toBeNull();
    expect(splitMatch("users", " ")).toBeNull();
  });

  it("does not mark a name whose length changes when lower-cased", () => {
    expect(splitMatch("İstanbul", "stan")).toBeNull();
  });
});
