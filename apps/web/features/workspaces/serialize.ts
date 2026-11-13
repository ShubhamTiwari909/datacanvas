/**
 * Turning the canvas into what gets SAVED, and back.
 *
 * React Flow's node objects hold more than we want on disk (measured sizes,
 * selection, internal flags). A workspace keeps only what a person arranged:
 * which tables, where, expanded or not, plus pan and zoom. This is the ONE place
 * that decides what that is.
 */
import type { SavedNode, SavedViewport, WorkspaceCanvas } from "@datacanvas/shared-types";
import type { TableFlowNode } from "@/stores/canvas-store";

/** Positions are saved to one decimal place: sub-pixel noise from dragging is not worth a file write. */
const round1 = (value: number): number => Math.round(value * 10) / 10;
const round3 = (value: number): number => Math.round(value * 1000) / 1000;

export function serializeCanvas(
  nodes: readonly TableFlowNode[],
  viewport: SavedViewport | null,
): WorkspaceCanvas {
  const saved: SavedNode[] = nodes.map((node) => ({
    schema: node.data.schema,
    name: node.data.name,
    x: round1(node.position.x),
    y: round1(node.position.y),
    expanded: node.data.expanded,
  }));
  return {
    nodes: saved,
    viewport: viewport
      ? { x: round1(viewport.x), y: round1(viewport.y), zoom: round3(viewport.zoom) }
      : null,
  };
}

/**
 * A string that is equal exactly when two saved canvases are equal. Autosave
 * compares it with the last saved one so changes that do not affect the file
 * (selecting a table, a node being measured) never cause a write.
 */
export function canvasSignature(canvas: WorkspaceCanvas, name: string): string {
  return JSON.stringify([
    name,
    canvas.nodes.map((n) => [n.schema, n.name, n.x, n.y, n.expanded]),
    canvas.viewport,
  ]);
}

/** Drop repeated tables from a saved list (a hand-edited file could contain one twice), keeping the first. */
export function uniqueSavedNodes(nodes: readonly SavedNode[]): SavedNode[] {
  const seen = new Set<string>();
  return nodes.filter((node) => {
    const key = JSON.stringify([node.schema, node.name]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
