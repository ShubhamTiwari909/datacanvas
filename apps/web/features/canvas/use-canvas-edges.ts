/**
 * Derives the edges to draw from (a) the relationships of the database and (b)
 * the tables currently on the canvas. Nothing about edges is ever stored.
 *
 * PERFORMANCE: dragging a node changes `nodes` on every mouse move, but edges
 * only depend on WHICH tables are present and whether each is expanded. The
 * store selectors below return small arrays of strings compared element by
 * element (`useShallow`), so while a node is being dragged they keep the same
 * identity, the memo below does not re-run, and React Flow is not handed a new
 * edge list sixty times a second.
 */
"use client";

import { buildEdges, type EdgeDescriptor, type EdgeNode } from "@datacanvas/canvas-engine";
import { MarkerType, type Edge } from "@xyflow/react";
import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { useCanvasStore } from "@/stores/canvas-store";
import { useMetadataStore } from "@/stores/metadata-store";

const NO_RELATIONSHIPS: never[] = [];

export function useCanvasEdges(connectionId: string): Edge[] {
  // One JSON string per node: [schema, name, expanded]. Changes only on add / remove / expand.
  const specs = useCanvasStore(
    useShallow((state) =>
      (state.canvases[connectionId]?.nodes ?? []).map((n) =>
        JSON.stringify([n.data.schema, n.data.name, n.data.expanded]),
      ),
    ),
  );
  const selectedIds = useCanvasStore(
    useShallow((state) =>
      (state.canvases[connectionId]?.nodes ?? []).filter((n) => n.selected).map((n) => n.id),
    ),
  );
  const metadata = useMetadataStore((state) => state.byConnection[connectionId]);
  const relationships = metadata?.relationships ?? NO_RELATIONSHIPS;
  const tables = metadata?.tables;

  const descriptors = useMemo<EdgeDescriptor[]>(() => {
    const nodes = specs.flatMap((spec): EdgeNode[] => {
      const [schema, name, expanded] = JSON.parse(spec) as [string, string, boolean];
      const entry = tables?.[JSON.stringify([schema, name])]; // same key as database-core's tableRefKey
      return entry ? [{ schema, name, expanded, columns: entry.columns.map((c) => c.name) }] : [];
    });
    return buildEdges(relationships, nodes);
  }, [specs, tables, relationships]);

  return useMemo(
    () =>
      descriptors.map((edge): Edge => {
        // Emphasise the edges of the selected tables, so relationships can be traced.
        const highlighted = selectedIds.includes(edge.source) || selectedIds.includes(edge.target);
        return {
          id: edge.id,
          source: edge.source,
          target: edge.target,
          sourceHandle: edge.sourceHandle,
          targetHandle: edge.targetHandle,
          label: edge.label,
          markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 },
          style: {
            stroke: highlighted ? "var(--foreground)" : "var(--muted-foreground)",
            strokeWidth: highlighted ? 2 : 1,
          },
          labelStyle: { fontSize: 10, fill: "var(--muted-foreground)" },
          labelBgStyle: { fill: "var(--background)" },
          labelBgPadding: [4, 2],
          zIndex: highlighted ? 10 : 0,
          data: { relationship: edge.relationship, cardinality: edge.cardinality },
        };
      }),
    [descriptors, selectedIds],
  );
}
