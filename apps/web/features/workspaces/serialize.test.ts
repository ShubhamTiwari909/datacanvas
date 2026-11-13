import { parseWorkspaceFile } from "@datacanvas/shared-types";
import { describe, expect, it } from "vitest";
import type { TableFlowNode } from "@/stores/canvas-store";
import { canvasSignature, serializeCanvas, uniqueSavedNodes } from "./serialize";

const node = (
  name: string,
  x: number,
  y: number,
  extra: Partial<TableFlowNode> = {},
): TableFlowNode => ({
  id: `["public","${name}"]`,
  type: "table",
  position: { x, y },
  data: { schema: "public", name, expanded: false, columnCount: 4, missing: false },
  ...extra,
});

describe("serializeCanvas", () => {
  it("keeps only identity, position and expansion: no selection, no measurements, no metadata", () => {
    const canvas = serializeCanvas(
      [
        node("users", 10, 20, {
          selected: true,
          measured: { width: 280, height: 150 },
          dragging: true,
        }),
      ],
      { x: 5, y: 6, zoom: 1 },
    );
    expect(canvas).toEqual({
      nodes: [{ schema: "public", name: "users", x: 10, y: 20, expanded: false }],
      viewport: { x: 5, y: 6, zoom: 1 },
    });
  });

  it("does not save the transient 'missing' flag or the estimated column count", () => {
    const [saved] = serializeCanvas(
      [
        {
          ...node("gone", 0, 0),
          data: { schema: "public", name: "gone", expanded: true, columnCount: 0, missing: true },
        },
      ],
      null,
    ).nodes;
    expect(Object.keys(saved ?? {}).sort()).toEqual(["expanded", "name", "schema", "x", "y"]);
    expect(saved?.expanded).toBe(true);
  });

  it("rounds positions and zoom so tiny drag noise does not matter", () => {
    const canvas = serializeCanvas([node("a", 10.04, -3.96)], {
      x: 1.234,
      y: 2.345,
      zoom: 0.123456,
    });
    expect(canvas.nodes[0]).toMatchObject({ x: 10, y: -4 });
    expect(canvas.viewport).toEqual({ x: 1.2, y: 2.3, zoom: 0.123 });
  });

  it("handles no viewport and no nodes", () => {
    expect(serializeCanvas([], null)).toEqual({ nodes: [], viewport: null });
  });

  it("produces something the workspace schema accepts, and that survives JSON text unchanged", () => {
    const canvas = serializeCanvas([node("orders", 100.5, -20.3), node("users", 0, 0)], {
      x: -50,
      y: 12.5,
      zoom: 0.5,
    });
    const file = {
      format: "datacanvas-workspace",
      schemaVersion: 1,
      id: "ws-abcdef12",
      name: "Layout",
      createdAt: "2026-11-13T10:00:00.000Z",
      updatedAt: "2026-11-13T10:00:00.000Z",
      profileId: null,
      connectionHint: null,
      canvas,
    };
    const loaded = parseWorkspaceFile(JSON.parse(JSON.stringify(file)));
    expect(loaded.ok && loaded.workspace.canvas).toEqual(canvas);
  });
});

describe("canvasSignature", () => {
  const base = serializeCanvas([node("a", 1, 2)], { x: 0, y: 0, zoom: 1 });

  it("is equal for equal documents and ignores selection", () => {
    const selected = serializeCanvas([node("a", 1, 2, { selected: true })], {
      x: 0,
      y: 0,
      zoom: 1,
    });
    expect(canvasSignature(selected, "L")).toBe(canvasSignature(base, "L"));
  });

  it("changes when a position, the expansion, the viewport, the table list or the name changes", () => {
    const sig = canvasSignature(base, "L");
    expect(
      canvasSignature(serializeCanvas([node("a", 9, 2)], { x: 0, y: 0, zoom: 1 }), "L"),
    ).not.toBe(sig);
    expect(
      canvasSignature(
        serializeCanvas(
          [{ ...node("a", 1, 2), data: { ...node("a", 1, 2).data, expanded: true } }],
          { x: 0, y: 0, zoom: 1 },
        ),
        "L",
      ),
    ).not.toBe(sig);
    expect(
      canvasSignature(serializeCanvas([node("a", 1, 2)], { x: 0, y: 0, zoom: 2 }), "L"),
    ).not.toBe(sig);
    expect(
      canvasSignature(
        serializeCanvas([node("a", 1, 2), node("b", 0, 0)], { x: 0, y: 0, zoom: 1 }),
        "L",
      ),
    ).not.toBe(sig);
    expect(canvasSignature(base, "Renamed")).not.toBe(sig);
  });
});

describe("uniqueSavedNodes", () => {
  it("keeps the first of repeated tables, in order", () => {
    const saved = (name: string, x: number) => ({
      schema: "public",
      name,
      x,
      y: 0,
      expanded: false,
    });
    expect(uniqueSavedNodes([saved("a", 1), saved("b", 2), saved("a", 3)])).toEqual([
      saved("a", 1),
      saved("b", 2),
    ]);
  });
});
