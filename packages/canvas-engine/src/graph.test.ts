import type { RelationshipInfo } from "@datacanvas/database-core";
import { describe, expect, it } from "vitest";
import {
  connectedComponents,
  reachableWithin,
  relationshipEdges,
  shortestPath,
  type GraphEdge,
} from "./graph.js";
import { nodeIdFor } from "./ids.js";

/**
 * The shop, as edges (source = table holding the foreign key):
 *
 *   order_items -> orders -> users <- user_profiles
 *   order_items -> products
 *   addresses -> regions            (a separate island)
 *   audit_log                       (no relationships at all)
 */
const e = (source: string, target: string): GraphEdge => ({ source, target });
const edges = [
  e("order_items", "orders"),
  e("order_items", "products"),
  e("orders", "users"),
  e("user_profiles", "users"),
  e("addresses", "regions"),
];
const sorted = (map: Map<string, number>) =>
  Object.fromEntries([...map].sort(([a], [b]) => a.localeCompare(b)));

describe("reachableWithin", () => {
  it("0 hops is just the start", () => {
    expect(sorted(reachableWithin(["orders"], edges, 0))).toEqual({ orders: 0 });
  });

  it("walks outward one level at a time and records distances", () => {
    expect(sorted(reachableWithin(["orders"], edges, 1))).toEqual({
      order_items: 1,
      orders: 0,
      users: 1,
    });
    expect(sorted(reachableWithin(["orders"], edges, 2))).toEqual({
      order_items: 1,
      orders: 0,
      products: 2,
      user_profiles: 2,
      users: 1,
    });
  });

  it("follows only parents with direction 'outgoing' (the tables this one depends on)", () => {
    expect(sorted(reachableWithin(["order_items"], edges, 5, "outgoing"))).toEqual({
      order_items: 0,
      orders: 1,
      products: 1,
      users: 2,
    });
  });

  it("follows only children with direction 'incoming' (the tables that depend on this one)", () => {
    expect(sorted(reachableWithin(["users"], edges, 5, "incoming"))).toEqual({
      order_items: 2,
      orders: 1,
      user_profiles: 1,
      users: 0,
    });
  });

  it("never reaches the separate island", () => {
    const reached = reachableWithin(["orders"], edges, Infinity);
    expect(reached.has("addresses")).toBe(false);
    expect(reached.size).toBe(5);
  });

  it("starts from several tables at once, each at distance 0", () => {
    const reached = reachableWithin(["products", "regions"], edges, 1);
    expect(sorted(reached)).toEqual({ addresses: 1, order_items: 1, products: 0, regions: 0 });
  });

  it("keeps an isolated start node, and tolerates a start that is not in any edge", () => {
    expect(sorted(reachableWithin(["audit_log"], edges, 3))).toEqual({ audit_log: 0 });
  });

  it("terminates on cycles, and gives the shortest distance", () => {
    const cycle = [e("a", "b"), e("b", "c"), e("c", "a")];
    expect(sorted(reachableWithin(["a"], cycle, 10))).toEqual({ a: 0, b: 1, c: 1 }); // c is 1 away via c -> a
  });

  it("ignores self-references and duplicate edges", () => {
    const messy = [e("t", "t"), e("t", "u"), e("t", "u")];
    expect(sorted(reachableWithin(["t"], messy, 3))).toEqual({ t: 0, u: 1 });
  });

  it("treats no edges as no neighbours", () => {
    expect(sorted(reachableWithin(["x"], [], 3))).toEqual({ x: 0 });
  });

  it("handles a long chain without recursion problems", () => {
    const chain = Array.from({ length: 5000 }, (_v, i) => e(`n${i}`, `n${i + 1}`));
    const reached = reachableWithin(["n0"], chain, Infinity);
    expect(reached.size).toBe(5001);
    expect(reached.get("n5000")).toBe(5000);
  });
});

describe("shortestPath", () => {
  it("finds the shortest chain between two tables, ignoring direction by default", () => {
    expect(shortestPath("user_profiles", "products", edges)).toEqual([
      "user_profiles",
      "users",
      "orders",
      "order_items",
      "products",
    ]);
  });

  it("respects direction when asked", () => {
    expect(shortestPath("order_items", "users", edges, "outgoing")).toEqual([
      "order_items",
      "orders",
      "users",
    ]);
    expect(shortestPath("users", "order_items", edges, "outgoing")).toBeNull();
  });

  it("returns just the table for a path from a table to itself", () => {
    expect(shortestPath("users", "users", edges)).toEqual(["users"]);
  });

  it("returns null when the tables are not connected", () => {
    expect(shortestPath("users", "regions", edges)).toBeNull();
    expect(shortestPath("users", "audit_log", edges)).toBeNull();
  });

  it("picks a SHORTEST path when several exist", () => {
    const diamond = [e("a", "b"), e("b", "d"), e("a", "c"), e("c", "x"), e("x", "d"), e("a", "d")];
    expect(shortestPath("a", "d", diamond)).toEqual(["a", "d"]);
  });
});

describe("connectedComponents", () => {
  const all = [
    "order_items",
    "orders",
    "users",
    "products",
    "user_profiles",
    "addresses",
    "regions",
    "audit_log",
  ];

  it("separates the clusters and keeps the given order", () => {
    expect(connectedComponents(all, edges)).toEqual([
      ["order_items", "orders", "users", "products", "user_profiles"],
      ["addresses", "regions"],
      ["audit_log"],
    ]);
  });

  it("ignores edges that point at tables that are not in the list", () => {
    expect(connectedComponents(["orders", "users"], edges)).toEqual([["orders", "users"]]);
    expect(connectedComponents(["orders", "products"], edges)).toEqual([["orders"], ["products"]]); // linked only through order_items
  });

  it("returns nothing for no nodes", () => {
    expect(connectedComponents([], edges)).toEqual([]);
  });
});

describe("relationshipEdges", () => {
  it("makes one edge per foreign key between node ids", () => {
    const rel: RelationshipInfo = {
      name: "orders_user_fkey",
      source: { schema: "public", table: "orders", columns: ["user_id"] },
      target: { schema: "public", table: "users", columns: ["id"] },
      cardinality: "many-to-one",
      onDelete: "no_action",
      onUpdate: "no_action",
    };
    expect(relationshipEdges([rel])).toEqual([
      {
        source: nodeIdFor({ schema: "public", name: "orders" }),
        target: nodeIdFor({ schema: "public", name: "users" }),
      },
    ]);
  });
});
