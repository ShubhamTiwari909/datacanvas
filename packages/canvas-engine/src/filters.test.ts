import { describe, expect, it } from "vitest";
import {
  ALL_RELATIONSHIP_TYPES,
  DEFAULT_FILTERS,
  filterEdges,
  visibleNodeIds,
  type FilterableNode,
} from "./filters.js";

const nodes: FilterableNode[] = [
  { id: "users", schema: "public", kind: "table" },
  { id: "active_users", schema: "public", kind: "view" },
  { id: "daily_sales", schema: "analytics", kind: "materialized_view" },
  { id: "events", schema: "analytics", kind: "table" },
  { id: "loading", schema: "public", kind: null },
];

describe("visibleNodeIds", () => {
  it("shows everything by default", () => {
    expect(visibleNodeIds(nodes, DEFAULT_FILTERS).size).toBe(5);
  });

  it("hides whole schemas", () => {
    const visible = visibleNodeIds(nodes, { ...DEFAULT_FILTERS, hiddenSchemas: ["analytics"] });
    expect([...visible].sort()).toEqual(["active_users", "loading", "users"]);
  });

  it("hides views and materialized views, but not tables or tables still loading", () => {
    const visible = visibleNodeIds(nodes, { ...DEFAULT_FILTERS, showViews: false });
    expect([...visible].sort()).toEqual(["events", "loading", "users"]);
  });

  it("hides individual tables", () => {
    const visible = visibleNodeIds(nodes, { ...DEFAULT_FILTERS, hiddenIds: ["users", "events"] });
    expect(visible.has("users")).toBe(false);
    expect(visible.has("events")).toBe(false);
    expect(visible.size).toBe(3);
  });

  it("combines filters", () => {
    const visible = visibleNodeIds(nodes, {
      hiddenSchemas: ["analytics"],
      showViews: false,
      hiddenIds: ["loading"],
    });
    expect([...visible]).toEqual(["users"]);
  });
});

describe("filterEdges", () => {
  const edge = (source: string, target: string, cardinality: "many-to-one" | "one-to-one") => ({
    source,
    target,
    cardinality,
  });
  const edges = [
    edge("a", "b", "many-to-one"),
    edge("c", "b", "one-to-one"),
    edge("a", "hidden", "many-to-one"),
  ];

  it("drops edges that touch a hidden table", () => {
    const visible = new Set(["a", "b", "c"]);
    expect(filterEdges(edges, visible, ALL_RELATIONSHIP_TYPES)).toHaveLength(2);
  });

  it("drops a relationship type that is switched off", () => {
    const visible = new Set(["a", "b", "c", "hidden"]);
    expect(filterEdges(edges, visible, { manyToOne: false, oneToOne: true })).toEqual([
      edge("c", "b", "one-to-one"),
    ]);
    expect(filterEdges(edges, visible, { manyToOne: true, oneToOne: false })).toHaveLength(2);
    expect(filterEdges(edges, visible, { manyToOne: false, oneToOne: false })).toEqual([]);
  });
});
