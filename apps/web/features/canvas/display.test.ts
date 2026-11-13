import type { EdgeDescriptor, FilterableNode } from "@datacanvas/canvas-engine";
import { ALL_RELATIONSHIP_TYPES, DEFAULT_FILTERS } from "@datacanvas/canvas-engine";
import { describe, expect, it } from "vitest";
import { DEFAULT_VIEW } from "@/stores/canvas-view-store";
import { computeDisplay, type DisplayInput } from "./display";

/**
 * A chain  a -> b -> c -> d  (arrows point at the referenced table),
 * a branch b -> e, and an isolated table z. Tables c and e are views.
 */
const node = (
  id: string,
  kind: FilterableNode["kind"] = "table",
  schema = "public",
): FilterableNode => ({ id, schema, kind });
const edge = (
  source: string,
  target: string,
  cardinality: EdgeDescriptor["cardinality"] = "many-to-one",
): EdgeDescriptor => ({
  id: `${source}>${target}`,
  source,
  target,
  sourceHandle: "s",
  targetHandle: "t",
  relationship: `${source}_fkey`,
  cardinality,
  label: cardinality === "one-to-one" ? "1:1" : "N:1",
});

const base: DisplayInput = {
  nodes: [node("a"), node("b"), node("c", "view"), node("d"), node("e", "view"), node("z")],
  edges: [edge("a", "b"), edge("b", "c"), edge("c", "d"), edge("b", "e", "one-to-one")],
  selectedIds: [],
  filters: DEFAULT_FILTERS,
  relationshipTypes: ALL_RELATIONSHIP_TYPES,
  focus: DEFAULT_VIEW.focus,
};
const ids = (set: ReadonlySet<string>) => [...set].sort();
const edgeIds = (display: ReturnType<typeof computeDisplay>) =>
  display.edges.map((e) => e.edge.id).sort();

describe("computeDisplay: no filters, no focus", () => {
  it("shows everything normally", () => {
    const result = computeDisplay(base);
    expect(ids(result.hiddenIds)).toEqual([]);
    expect(ids(result.dimmedIds)).toEqual([]);
    expect(result.edges).toHaveLength(4);
    expect(result.edges.every((e) => !e.dimmed)).toBe(true);
    expect(result.focusActive).toBe(false);
  });
});

describe("filters", () => {
  it("hiding a table hides its edges too", () => {
    const result = computeDisplay({ ...base, filters: { ...DEFAULT_FILTERS, hiddenIds: ["b"] } });
    expect(ids(result.hiddenIds)).toEqual(["b"]);
    expect(edgeIds(result)).toEqual(["c>d"]); // every other edge touches b
  });

  it("hiding views hides views and their edges", () => {
    const result = computeDisplay({ ...base, filters: { ...DEFAULT_FILTERS, showViews: false } });
    expect(ids(result.hiddenIds)).toEqual(["c", "e"]);
    expect(edgeIds(result)).toEqual(["a>b"]);
  });

  it("hiding a schema hides all of its tables", () => {
    const withSchemas = {
      ...base,
      nodes: [node("a", "table", "x"), node("b", "table", "y")],
      edges: [edge("a", "b")],
    };
    const result = computeDisplay({
      ...withSchemas,
      filters: { ...DEFAULT_FILTERS, hiddenSchemas: ["x"] },
    });
    expect(ids(result.hiddenIds)).toEqual(["a"]);
    expect(result.edges).toEqual([]);
  });

  it("switching off a relationship type removes those edges only", () => {
    const result = computeDisplay({
      ...base,
      relationshipTypes: { manyToOne: true, oneToOne: false },
    });
    expect(edgeIds(result)).toEqual(["a>b", "b>c", "c>d"]);
    expect(ids(result.hiddenIds)).toEqual([]); // tables stay
  });
});

describe("focus mode", () => {
  const focused = (
    selected: string[],
    mode: "dim" | "hide",
    hops: number,
    direction: "both" | "outgoing" | "incoming" = "both",
  ) => computeDisplay({ ...base, selectedIds: selected, focus: { mode, hops, direction } });

  it("does nothing when nothing is selected, even with the mode on", () => {
    const result = focused([], "hide", 1);
    expect(result.focusActive).toBe(false);
    expect(ids(result.hiddenIds)).toEqual([]);
  });

  it("does nothing when the mode is off, even with a selection", () => {
    const result = computeDisplay({
      ...base,
      selectedIds: ["b"],
      focus: { mode: "off", hops: 1, direction: "both" },
    });
    expect(result.focusActive).toBe(false);
    expect(ids(result.dimmedIds)).toEqual([]);
  });

  it("dims everything beyond N hops of the selection, and the edges outside the focus", () => {
    const result = focused(["b"], "dim", 1);
    expect(result.focusActive).toBe(true);
    expect(ids(result.dimmedIds)).toEqual(["d", "z"]); // a, c, e are 1 hop from b
    expect(ids(result.hiddenIds)).toEqual([]);
    const dimmed = Object.fromEntries(result.edges.map((e) => [e.edge.id, e.dimmed]));
    expect(dimmed).toEqual({ "a>b": false, "b>c": false, "c>d": true, "b>e": false });
  });

  it("hides everything beyond N hops, and their edges", () => {
    const result = focused(["b"], "hide", 1);
    expect(ids(result.hiddenIds)).toEqual(["d", "z"]);
    expect(edgeIds(result)).toEqual(["a>b", "b>c", "b>e"]);
  });

  it("reaches further with more hops", () => {
    const result = focused(["b"], "hide", 2);
    expect(ids(result.hiddenIds)).toEqual(["z"]);
  });

  it("follows only the chosen direction", () => {
    expect(ids(focused(["b"], "hide", 5, "outgoing").hiddenIds)).toEqual(["a", "z"]); // b -> c -> d, b -> e
    expect(ids(focused(["b"], "hide", 5, "incoming").hiddenIds)).toEqual(["c", "d", "e", "z"]); // only a -> b
  });

  it("focuses on several selected tables at once", () => {
    const result = focused(["a", "z"], "hide", 1);
    expect(ids(result.hiddenIds)).toEqual(["c", "d", "e"]);
  });

  it("reports each table's distance from the selection", () => {
    const result = focused(["b"], "dim", 5);
    expect(Object.fromEntries(result.reach ?? [])).toEqual({ b: 0, a: 1, c: 1, e: 1, d: 2 });
  });

  it("uses only the edges that are still drawn (a switched-off relationship type does not connect tables)", () => {
    const result = computeDisplay({
      ...base,
      selectedIds: ["b"],
      focus: { mode: "hide", hops: 1, direction: "both" },
      relationshipTypes: { manyToOne: true, oneToOne: false },
    });
    expect(ids(result.hiddenIds)).toEqual(["d", "e", "z"]); // e is only linked to b by the hidden 1:1 edge
  });

  it("ignores a selected table that a filter has hidden", () => {
    const result = computeDisplay({
      ...base,
      selectedIds: ["b"],
      filters: { ...DEFAULT_FILTERS, hiddenIds: ["b"] },
      focus: { mode: "hide", hops: 1, direction: "both" },
    });
    expect(result.focusActive).toBe(false);
    expect(ids(result.hiddenIds)).toEqual(["b"]);
  });
});
