/**
 * Everything the canvas needs to know about what to SHOW, derived from the
 * layout, the cached metadata and the view settings: the edges to draw, which
 * tables are hidden or dimmed.
 *
 * PERFORMANCE: dragging a node changes `nodes` on every mouse move, but this
 * result only depends on WHICH tables are present, whether each is expanded,
 * which are selected, and the view settings. The store selectors below return
 * small arrays of strings compared element by element (`useShallow`), so
 * during a drag they keep the same identity, the memos do not re-run, and
 * React Flow is not handed a new edge list sixty times a second.
 */
"use client";

import type { EdgeDescriptor } from "@datacanvas/canvas-engine";
import type { FilterableNode } from "@datacanvas/canvas-engine";
import { MarkerType, type Edge } from "@xyflow/react";
import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { useCanvasStore } from "@/stores/canvas-store";
import { useCanvasViewStore, viewOf } from "@/stores/canvas-view-store";
import { useMetadataStore } from "@/stores/metadata-store";
import { computeDisplay } from "./display";
import { describeEdges, nodeSpec } from "./edge-descriptors";

const NO_RELATIONSHIPS: never[] = [];

export interface CanvasDisplay {
  edges: Edge[];
  hiddenIds: ReadonlySet<string>;
  dimmedIds: ReadonlySet<string>;
  focusActive: boolean;
}

export function useCanvasDisplay(connectionId: string): CanvasDisplay {
  // One JSON string per node: [schema, name, expanded]. Changes only on add / remove / expand.
  const specs = useCanvasStore(
    useShallow((state) =>
      (state.canvases[connectionId]?.nodes ?? []).map((n) =>
        nodeSpec(n.data.schema, n.data.name, n.data.expanded),
      ),
    ),
  );
  const selectedIds = useCanvasStore(
    useShallow((state) =>
      (state.canvases[connectionId]?.nodes ?? []).filter((n) => n.selected).map((n) => n.id),
    ),
  );
  const metadata = useMetadataStore((state) => state.byConnection[connectionId]);
  const view = useCanvasViewStore((state) => viewOf(state.views, connectionId));
  const relationships = metadata?.relationships ?? NO_RELATIONSHIPS;
  const tables = metadata?.tables;

  const descriptors = useMemo<EdgeDescriptor[]>(
    () => describeEdges(specs, tables, relationships),
    [specs, tables, relationships],
  );

  const display = useMemo(() => {
    const nodes = specs.map((spec): FilterableNode => {
      const [schema, name] = JSON.parse(spec) as [string, string, boolean];
      const id = JSON.stringify([schema, name]);
      return { id, schema, kind: tables?.[id]?.table.kind ?? null };
    });
    return computeDisplay({
      nodes,
      edges: descriptors,
      selectedIds,
      filters: view.filters,
      relationshipTypes: view.relationshipTypes,
      focus: view.focus,
    });
  }, [specs, tables, descriptors, selectedIds, view]);

  return useMemo(() => {
    const selected = new Set(selectedIds);
    const edges = display.edges.map(({ edge, dimmed }): Edge => {
      // Emphasise the edges of the selected tables, so relationships can be traced.
      const highlighted = selected.has(edge.source) || selected.has(edge.target);
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
          opacity: dimmed ? 0.12 : 1,
        },
        labelStyle: { fontSize: 10, fill: "var(--muted-foreground)", opacity: dimmed ? 0.12 : 1 },
        labelBgStyle: { fill: "var(--background)", opacity: dimmed ? 0.12 : 1 },
        labelBgPadding: [4, 2],
        zIndex: highlighted ? 10 : 0,
        data: { relationship: edge.relationship, cardinality: edge.cardinality },
      };
    });
    return {
      edges,
      hiddenIds: display.hiddenIds,
      dimmedIds: display.dimmedIds,
      focusActive: display.focusActive,
    };
  }, [display, selectedIds]);
}
