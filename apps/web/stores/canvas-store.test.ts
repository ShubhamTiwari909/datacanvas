import { NODE_GAP_X, NODE_WIDTH, nodeIdFor } from "@datacanvas/canvas-engine";
import { beforeEach, describe, expect, it } from "vitest";
import { useCanvasStore } from "./canvas-store";

const C = "conn-1";
const table = (name: string, columnCount = 4) => ({ ref: { schema: "public", name }, columnCount });
const id = (name: string) => nodeIdFor({ schema: "public", name });
const nodes = (connection = C) => useCanvasStore.getState().canvases[connection]?.nodes ?? [];
const store = () => useCanvasStore.getState();

beforeEach(() => {
  useCanvasStore.setState({ canvases: {}, focusRequest: null, busy: false, error: null });
});

describe("addTables", () => {
  it("lays the first tables out as a grid and asks the view to fit them", () => {
    store().addTables(C, [table("a"), table("b"), table("c"), table("d")]);
    expect(nodes().map((n) => n.position)).toEqual([
      { x: 0, y: 0 },
      { x: NODE_WIDTH + NODE_GAP_X, y: 0 },
      { x: 0, y: expect.any(Number) },
      { x: NODE_WIDTH + NODE_GAP_X, y: expect.any(Number) },
    ]);
    expect(store().canvases[C]?.layoutVersion).toBe(1);
  });

  it("stores identity and view state only: no column metadata", () => {
    store().addTables(C, [table("users", 7)]);
    expect(nodes()[0]).toMatchObject({
      id: id("users"),
      type: "table",
      data: { schema: "public", name: "users", expanded: false, columnCount: 7 },
    });
    expect(Object.keys(nodes()[0]?.data ?? {}).sort()).toEqual([
      "columnCount",
      "expanded",
      "name",
      "schema",
    ]);
  });

  it("adds only tables that are not already there, without moving the others", () => {
    store().addTables(C, [table("a"), table("b")]);
    const before = nodes().map((n) => [n.id, n.position]);
    store().addTables(C, [table("b"), table("c")]);

    expect(nodes().map((n) => n.id)).toEqual([id("a"), id("b"), id("c")]);
    expect(
      nodes()
        .slice(0, 2)
        .map((n) => [n.id, n.position]),
    ).toEqual(before);
    expect(store().canvases[C]?.layoutVersion).toBe(1); // adding to a non-empty canvas does not refit
  });

  it("puts a new table where nothing else is", () => {
    store().addTables(C, [table("a"), table("b"), table("c")]);
    store().addTables(C, [table("d")]);
    const positions = nodes().map((n) => `${n.position.x},${n.position.y}`);
    expect(new Set(positions).size).toBe(4);
  });

  it("keeps connections separate", () => {
    store().addTables("one", [table("a")]);
    store().addTables("two", [table("b")]);
    expect(nodes("one").map((n) => n.id)).toEqual([id("a")]);
    expect(nodes("two").map((n) => n.id)).toEqual([id("b")]);
  });

  it("ignores an empty list", () => {
    store().addTables(C, []);
    expect(nodes()).toEqual([]);
    expect(store().canvases[C]?.layoutVersion ?? 0).toBe(0);
  });
});

describe("changes made by dragging, selecting and removing", () => {
  beforeEach(() => store().addTables(C, [table("a"), table("b")]));

  it("applies a drag as a new position", () => {
    store().applyChanges(C, [
      { type: "position", id: id("a"), position: { x: 500, y: 300 }, dragging: true },
    ]);
    expect(nodes()[0]?.position).toEqual({ x: 500, y: 300 });
  });

  it("applies selection changes", () => {
    store().applyChanges(C, [{ type: "select", id: id("b"), selected: true }]);
    expect(nodes().map((n) => Boolean(n.selected))).toEqual([false, true]);
  });

  it("removes nodes when React Flow reports a removal (the Delete key)", () => {
    store().applyChanges(C, [{ type: "remove", id: id("a") }]);
    expect(nodes().map((n) => n.id)).toEqual([id("b")]);
  });
});

describe("toolbar actions", () => {
  beforeEach(() => store().addTables(C, [table("a"), table("b"), table("c")]));

  it("selects all, then removes only the selected", () => {
    store().selectOnly(C, id("b"));
    expect(
      nodes()
        .filter((n) => n.selected)
        .map((n) => n.id),
    ).toEqual([id("b")]);

    store().removeSelected(C);
    expect(nodes().map((n) => n.id)).toEqual([id("a"), id("c")]);

    store().selectAll(C);
    expect(nodes().every((n) => n.selected)).toBe(true);
  });

  it("selecting one table deselects the others", () => {
    store().selectAll(C);
    store().selectOnly(C, id("a"));
    expect(
      nodes()
        .filter((n) => n.selected)
        .map((n) => n.id),
    ).toEqual([id("a")]);
  });

  it("expands and collapses a table", () => {
    store().toggleExpanded(C, id("a"));
    expect(nodes()[0]?.data.expanded).toBe(true);
    store().toggleExpanded(C, id("a"));
    expect(nodes()[0]?.data.expanded).toBe(false);
  });

  it("resets the layout to a tidy grid, keeping reading order, and asks for a refit", () => {
    // Scatter the nodes, with "c" ending up first in reading order.
    store().applyChanges(C, [
      { type: "position", id: id("a"), position: { x: 900, y: 900 } },
      { type: "position", id: id("b"), position: { x: 100, y: 500 } },
      { type: "position", id: id("c"), position: { x: 50, y: 10 } },
    ]);
    const versionBefore = store().canvases[C]?.layoutVersion ?? 0;

    store().resetLayout(C);

    const byId = Object.fromEntries(nodes().map((n) => [n.id, n.position]));
    expect(byId[id("c")]).toEqual({ x: 0, y: 0 }); // first in reading order
    expect(store().canvases[C]?.layoutVersion).toBe(versionBefore + 1);
    const positions = Object.values(byId).map((p) => `${p.x},${p.y}`);
    expect(new Set(positions).size).toBe(3);
  });
});

describe("focus requests and cleanup", () => {
  it("records and clears a focus request", () => {
    store().requestFocus(C, id("a"));
    expect(store().focusRequest).toEqual({ connectionId: C, nodeId: id("a") });
    store().clearFocus();
    expect(store().focusRequest).toBeNull();
  });

  it("forgets a connection's canvas", () => {
    store().addTables(C, [table("a")]);
    store().dropConnection(C);
    expect(store().canvases[C]).toBeUndefined();
  });
});
