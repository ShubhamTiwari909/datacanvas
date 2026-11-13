import type { RelationshipInfo } from "@datacanvas/database-core";
import { describe, expect, it } from "vitest";
import { MAX_PATHS, buildJoinSql, findPaths, type FoundPath } from "./path-finder";

const rel = (
  source: string,
  sourceColumns: string[],
  target: string,
  targetColumns: string[] = ["id"],
  name = `${source}_${sourceColumns.join("_")}_fk`,
  schemas: [string, string] = ["public", "public"],
): RelationshipInfo => ({
  name,
  source: { schema: schemas[0], table: source, columns: sourceColumns },
  target: { schema: schemas[1], table: target, columns: targetColumns },
  cardinality: "many-to-one",
  onDelete: "no_action",
  onUpdate: "no_action",
});
const t = (table: string, schema = "public") => ({ schema, table });

const shop = [
  rel("order_items", ["order_id"], "orders"),
  rel("order_items", ["product_id"], "products"),
  rel("orders", ["user_id"], "users"),
  rel("user_profiles", ["user_id"], "users"),
];

function found(result: ReturnType<typeof findPaths>) {
  if (result.status !== "found") throw new Error(`expected a path, got ${result.status}`);
  return result;
}

describe("findPaths", () => {
  it("follows a chain of foreign keys child to parent", () => {
    const result = found(findPaths(shop, t("order_items"), t("users")));
    expect(result.length).toBe(2);
    expect(result.paths).toHaveLength(1);
    expect(result.paths[0]?.tables.map((x) => x.table)).toEqual(["order_items", "orders", "users"]);
    expect(result.paths[0]?.steps.map((s) => s.direction)).toEqual(["references", "references"]);
    expect(result.paths[0]?.multipliesRows).toBe(false);
  });

  it("follows keys backwards too, and says one row can match many", () => {
    const result = found(findPaths(shop, t("users"), t("order_items")));
    expect(result.paths[0]?.tables.map((x) => x.table)).toEqual(["users", "orders", "order_items"]);
    expect(result.paths[0]?.steps.map((s) => s.direction)).toEqual([
      "referenced_by",
      "referenced_by",
    ]);
    expect(result.paths[0]?.multipliesRows).toBe(true);
  });

  it("goes up and then down between siblings (products to user_profiles)", () => {
    const result = found(findPaths(shop, t("products"), t("user_profiles")));
    expect(result.paths[0]?.tables.map((x) => x.table)).toEqual([
      "products",
      "order_items",
      "orders",
      "users",
      "user_profiles",
    ]);
    expect(result.paths[0]?.steps.map((s) => s.direction)).toEqual([
      "referenced_by",
      "references",
      "references",
      "referenced_by",
    ]);
  });

  it("prefers the shortest route", () => {
    const withShortcut = [...shop, rel("order_items", ["user_id"], "users")];
    const result = found(findPaths(withShortcut, t("order_items"), t("users")));
    expect(result.length).toBe(1);
    expect(result.paths[0]?.tables.map((x) => x.table)).toEqual(["order_items", "users"]);
  });

  it("returns every shortest route when several exist, in a stable order", () => {
    const diamond = [
      rel("a", ["b_id"], "b"),
      rel("a", ["c_id"], "c"),
      rel("b", ["d_id"], "d"),
      rel("c", ["d_id"], "d"),
    ];
    const result = found(findPaths(diamond, t("a"), t("d")));
    expect(result.paths.map((p) => p.tables.map((x) => x.table).join(">"))).toEqual([
      "a>b>d",
      "a>c>d",
    ]);
    expect(findPaths(diamond, t("a"), t("d"))).toEqual(findPaths(diamond, t("a"), t("d")));
  });

  it("treats two foreign keys between the same tables as two paths", () => {
    const addresses = [
      rel("orders", ["billing_id"], "addresses", ["id"], "orders_billing_fk"),
      rel("orders", ["shipping_id"], "addresses", ["id"], "orders_shipping_fk"),
    ];
    const result = found(findPaths(addresses, t("orders"), t("addresses")));
    expect(result.paths).toHaveLength(2);
    expect(result.paths.map((p) => p.steps[0]?.fromColumns)).toEqual([
      ["billing_id"],
      ["shipping_id"],
    ]);
  });

  it("limits the alternatives and says the list was cut", () => {
    const many = Array.from({ length: MAX_PATHS + 3 }, (_v, i) =>
      rel("a", [`k${i}`], "b", ["id"], `fk_${String(i).padStart(2, "0")}`),
    );
    const result = found(findPaths(many, t("a"), t("b")));
    expect(result.paths).toHaveLength(MAX_PATHS);
    expect(result.truncated).toBe(true);
    expect(found(findPaths(many.slice(0, 2), t("a"), t("b"))).truncated).toBe(false);
  });

  it("reports no path between unconnected tables or unknown tables", () => {
    expect(findPaths(shop, t("users"), t("lonely"))).toEqual({ status: "none" });
    expect(findPaths([], t("a"), t("b"))).toEqual({ status: "none" });
  });

  it("reports the same table, and ignores self-references", () => {
    expect(findPaths(shop, t("users"), t("users"))).toEqual({ status: "same_table" });
    const tree = [rel("tree", ["parent_id"], "tree"), rel("leaf", ["tree_id"], "tree")];
    expect(findPaths(tree, t("leaf"), t("tree")).status).toBe("found");
  });

  it("keeps a table with the same name in two schemas apart", () => {
    const rels = [rel("shared", ["public_id"], "shared", ["id"], "cross", ["other", "public"])];
    const result = found(findPaths(rels, t("shared", "other"), t("shared", "public")));
    expect(result.paths[0]?.tables).toEqual([t("shared", "other"), t("shared", "public")]);
    expect(findPaths(rels, t("shared", "other"), t("shared", "other")).status).toBe("same_table");
  });

  it("copes with a long chain", () => {
    const chain = Array.from({ length: 300 }, (_v, i) => rel(`t${i}`, ["p"], `t${i + 1}`));
    expect(found(findPaths(chain, t("t0"), t("t300"))).length).toBe(300);
  });

  it("copes with a densely connected graph without blowing up", () => {
    // Layers of 6 tables, each connected to every table of the next layer: 6^8 shortest paths.
    const layers = 9;
    const width = 6;
    const dense: RelationshipInfo[] = [];
    for (let l = 0; l < layers - 1; l += 1)
      for (let i = 0; i < width; i += 1)
        for (let j = 0; j < width; j += 1)
          dense.push(rel(`l${l}_${i}`, [`k${j}`], `l${l + 1}_${j}`));
    const start = performance.now();
    const result = found(findPaths(dense, t("l0_0"), t(`l${layers - 1}_0`)));
    expect(result.paths).toHaveLength(MAX_PATHS);
    expect(result.truncated).toBe(true);
    expect(performance.now() - start).toBeLessThan(1000);
  });
});

describe("step columns", () => {
  it("aligns columns in the direction of travel", () => {
    const [down] = found(findPaths(shop, t("order_items"), t("orders"))).paths;
    expect(down?.steps[0]).toMatchObject({ fromColumns: ["order_id"], toColumns: ["id"] });
    const [up] = found(findPaths(shop, t("orders"), t("order_items"))).paths;
    expect(up?.steps[0]).toMatchObject({ fromColumns: ["id"], toColumns: ["order_id"] });
  });
});

describe("buildJoinSql", () => {
  const sql = (path: FoundPath | undefined) => (path ? buildJoinSql(path) : "");

  it("writes a quoted join along the path", () => {
    const [path] = found(findPaths(shop, t("order_items"), t("users"))).paths;
    expect(sql(path)).toBe(
      [
        "SELECT *",
        'FROM "public"."order_items" AS t1',
        'JOIN "public"."orders" AS t2 ON t1."order_id" = t2."id"',
        'JOIN "public"."users" AS t3 ON t2."user_id" = t3."id"',
        "LIMIT 100;",
      ].join("\n"),
    );
  });

  it("joins composite keys on every column pair", () => {
    const composite = [rel("child", ["a", "b"], "parent", ["x", "y"])];
    const [path] = found(findPaths(composite, t("child"), t("parent"))).paths;
    expect(sql(path)).toContain('ON t1."a" = t2."x" AND t1."b" = t2."y"');
  });

  it("quotes awkward names so they stay names", () => {
    const awkward = [
      rel('Order "Items"', ["Unit Price ($)"], "; DROP TABLE users; --", ["select"], "fk", [
        "a b",
        "ünï",
      ]),
    ];
    const [path] = found(
      findPaths(awkward, t('Order "Items"', "a b"), t("; DROP TABLE users; --", "ünï")),
    ).paths;
    expect(sql(path)).toBe(
      [
        "SELECT *",
        'FROM "a b"."Order ""Items""" AS t1',
        'JOIN "ünï"."; DROP TABLE users; --" AS t2 ON t1."Unit Price ($)" = t2."select"',
        "LIMIT 100;",
      ].join("\n"),
    );
  });

  it("gives a table on its own no joins", () => {
    expect(buildJoinSql({ tables: [t("a")], steps: [], multipliesRows: false })).toBe(
      'SELECT *\nFROM "public"."a" AS t1\nLIMIT 100;',
    );
  });
});
