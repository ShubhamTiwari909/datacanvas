import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_VIEW, MAX_FOCUS_HOPS, useCanvasViewStore, viewOf } from "./canvas-view-store";

const C = "conn-1";
const store = () => useCanvasViewStore.getState();
const view = () => viewOf(store().views, C);

beforeEach(() => useCanvasViewStore.setState({ views: {} }));

describe("canvas view store", () => {
  it("starts with the defaults, and the same object each time", () => {
    expect(view()).toBe(DEFAULT_VIEW);
    expect(viewOf({}, "other")).toBe(DEFAULT_VIEW);
  });

  it("toggles a schema's visibility", () => {
    store().toggleSchema(C, "analytics");
    expect(view().filters.hiddenSchemas).toEqual(["analytics"]);
    store().toggleSchema(C, "analytics");
    expect(view().filters.hiddenSchemas).toEqual([]);
  });

  it("hides views, and individual tables without duplicates, and shows them all again", () => {
    store().setShowViews(C, false);
    store().hideTables(C, ["a", "b"]);
    store().hideTables(C, ["b", "c"]);
    expect(view().filters).toMatchObject({ showViews: false, hiddenIds: ["a", "b", "c"] });
    store().showAllTables(C);
    expect(view().filters.hiddenIds).toEqual([]);
    expect(view().filters.showViews).toBe(false); // only the hidden-tables list was cleared
  });

  it("switches relationship types independently", () => {
    store().setRelationshipType(C, "oneToOne", false);
    expect(view().relationshipTypes).toEqual({ manyToOne: true, oneToOne: false });
  });

  it("keeps focus hops within 1 to the maximum", () => {
    store().setFocus(C, { mode: "dim", hops: 0 });
    expect(view().focus).toMatchObject({ mode: "dim", hops: 1 });
    store().setFocus(C, { hops: 999 });
    expect(view().focus.hops).toBe(MAX_FOCUS_HOPS);
    store().setFocus(C, { hops: 2.7 });
    expect(view().focus.hops).toBe(2);
    expect(view().focus.mode).toBe("dim"); // unrelated fields are kept
  });

  it("resets filters, relationship types and focus but keeps the inspector setting", () => {
    store().toggleSchema(C, "x");
    store().setFocus(C, { mode: "hide" });
    store().setInspectorOpen(C, false);
    store().resetFilters(C);
    expect(view().filters).toEqual(DEFAULT_VIEW.filters);
    expect(view().focus).toEqual(DEFAULT_VIEW.focus);
    expect(view().inspectorOpen).toBe(false);
  });

  it("keeps connections separate, and forgets a dropped one", () => {
    store().toggleSchema("one", "s");
    expect(viewOf(store().views, "two")).toBe(DEFAULT_VIEW);
    store().dropConnection("one");
    expect(viewOf(store().views, "one")).toBe(DEFAULT_VIEW);
  });
});
