/**
 * Arranging the tables that are on the canvas.
 */
import { NODE_WIDTH, estimateNodeHeight } from "@datacanvas/canvas-engine";
import { useCanvasStore } from "@/stores/canvas-store";
import { useMetadataStore } from "@/stores/metadata-store";
import { describeEdges, nodeSpec } from "./edge-descriptors";
import { autoLayout, type AutoLayoutKind } from "./elk-layout";

export type LayoutChoice = AutoLayoutKind | "grid";
export type ActionResult = { ok: true } | { ok: false; message: string };

/**
 * Lay out every table on the connection's canvas.
 *   grid          the simple built-in grid (instant);
 *   hierarchical, compact, grouped    computed by ELK (see elk-layout.ts).
 * The view then zooms to fit the result.
 */
export async function applyLayout(
  connectionId: string,
  choice: LayoutChoice,
): Promise<ActionResult> {
  const canvas = useCanvasStore.getState();
  if (choice === "grid") {
    canvas.resetLayout(connectionId);
    return { ok: true };
  }

  const nodes = canvas.canvases[connectionId]?.nodes ?? [];
  if (nodes.length === 0) return { ok: true };

  const metadata = useMetadataStore.getState().byConnection[connectionId];
  const edges = describeEdges(
    nodes.map((n) => nodeSpec(n.data.schema, n.data.name, n.data.expanded)),
    metadata?.tables,
    metadata?.relationships ?? [],
  );

  try {
    const positions = await autoLayout(
      choice,
      nodes.map((n) => ({
        id: n.id,
        // The real size once drawn, otherwise the same estimate the grid layout uses.
        width: n.measured?.width ?? NODE_WIDTH,
        height: n.measured?.height ?? estimateNodeHeight(n.data.columnCount, n.data.expanded),
      })),
      edges.map((e) => ({ id: e.id, source: e.source, target: e.target })),
    );
    useCanvasStore.getState().setPositions(connectionId, positions);
    return { ok: true };
  } catch {
    // The layout library failed to load or run. Nothing was changed.
    return {
      ok: false,
      message: "The automatic layout could not be computed. Your tables were not moved.",
    };
  }
}
