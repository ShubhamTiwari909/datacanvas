import type { RelationshipInfo, TableInfo } from "@datacanvas/database-core";
import { describe, expect, it } from "vitest";
import {
  computeDatabaseOverview,
  computeSchemaOverview,
  relationshipDegrees,
} from "./schema-overview";

const table = (
  schema: string,
  name: string,
  kind: TableInfo["kind"] = "table",
  rows: number | null = null,
): TableInfo => ({ schema, name, kind, comment: null, estimatedRowCount: rows });

const rel = (
  source: [string, string],
  target: [string, string],
  name = `${source[1]}_fk`,
): RelationshipInfo => ({
  name,
  source: { schema: source[0], table: source[1], columns: ["a"] },
  target: { schema: target[0], table: target[1], columns: ["id"] },
  cardinality: "many-to-one",
  onDelete: "no_action",
  onUpdate: "no_action",
});

const publicTables = [
  table("public", "users", "table", 1000),
  table("public", "orders", "table", 50_000),
  table("public", "items", "table", 200_000),
  table("public", "lonely", "table", 5),
  table("public", "active_users", "view"),
  table("public", "daily", "materialized_view", 10),
];

const relationships = [
  rel(["public", "orders"], ["public", "users"]),
  rel(["public", "items"], ["public", "orders"]),
  rel(["analytics", "events"], ["public", "users"]),
  rel(["public", "orders"], ["billing", "accounts"]),
];

describe("relationshipDegrees", () => {
  it("counts the foreign keys touching each table", () => {
    const d = relationshipDegrees(relationships);
    expect(d.get(JSON.stringify(["public", "users"]))).toBe(2);
    expect(d.get(JSON.stringify(["public", "orders"]))).toBe(3);
    expect(d.get(JSON.stringify(["public", "lonely"]))).toBeUndefined();
  });

  it("counts a self-reference once", () => {
    const d = relationshipDegrees([rel(["public", "tree"], ["public", "tree"])]);
    expect(d.get(JSON.stringify(["public", "tree"]))).toBe(1);
  });
});

describe("computeSchemaOverview", () => {
  const o = computeSchemaOverview("public", publicTables, relationships);

  it("counts tables, views and materialized views separately", () => {
    expect([o.tableCount, o.viewCount, o.materializedViewCount]).toEqual([4, 1, 1]);
  });

  it("sums the known row estimates", () => {
    expect(o.estimatedRows).toBe(251_015);
  });

  it("reports null when no table has an estimate", () => {
    const none = computeSchemaOverview("s", [table("s", "a"), table("s", "v", "view")], []);
    expect(none.estimatedRows).toBeNull();
  });

  it("separates relationships inside, going out and coming in", () => {
    expect([o.relationshipsInside, o.relationshipsOut, o.relationshipsIn]).toEqual([2, 1, 1]);
  });

  it("lists connected schemas, most connections first", () => {
    expect(o.neighbours).toEqual([
      { schema: "analytics", count: 1 },
      { schema: "billing", count: 1 },
    ]);
  });

  it("ranks the most connected tables and skips unconnected ones", () => {
    expect(o.mostConnected).toEqual([
      { name: "orders", degree: 3 },
      { name: "users", degree: 2 },
      { name: "items", degree: 1 },
    ]);
  });

  it("finds orphans among ordinary tables only (views never have foreign keys)", () => {
    expect(o.orphans).toEqual(["lonely"]);
  });

  it("ranks the largest tables by estimate", () => {
    expect(o.largest.map((t) => t.name)).toEqual(["items", "orders", "users", "daily", "lonely"]);
  });

  it("ignores zero estimates in the largest list", () => {
    const z = computeSchemaOverview("s", [table("s", "a", "table", 0)], []);
    expect(z.largest).toEqual([]);
  });

  it("limits the top lists to five entries", () => {
    const many = Array.from({ length: 12 }, (_v, i) => table("s", `t${i}`, "table", i + 1));
    expect(computeSchemaOverview("s", many, []).largest).toHaveLength(5);
  });

  it("breaks ties by name so the order is stable", () => {
    const t = [table("s", "b"), table("s", "a")];
    const r = [rel(["s", "a"], ["s", "z"]), rel(["s", "b"], ["s", "z"])];
    expect(computeSchemaOverview("s", t, r).mostConnected.map((x) => x.name)).toEqual(["a", "b"]);
  });

  it("handles an empty schema", () => {
    expect(computeSchemaOverview("empty", [], relationships)).toMatchObject({
      tableCount: 0,
      estimatedRows: null,
      mostConnected: [],
      orphans: [],
      largest: [],
    });
  });
});

describe("computeDatabaseOverview", () => {
  const overview = computeDatabaseOverview(
    [
      { schema: "analytics", tables: [table("analytics", "events")] },
      { schema: "public", tables: publicTables },
      { schema: "billing", tables: [table("billing", "accounts"), table("billing", "invoices")] },
    ],
    relationships,
  );

  it("totals everything", () => {
    expect(overview).toMatchObject({
      schemaCount: 3,
      tableCount: 7,
      viewCount: 1,
      materializedViewCount: 1,
      relationshipCount: 4,
      crossSchemaRelationships: 2,
    });
  });

  it("puts the biggest schema first, then alphabetical", () => {
    expect(overview.schemas.map((s) => s.schema)).toEqual(["public", "billing", "analytics"]);
  });
});
