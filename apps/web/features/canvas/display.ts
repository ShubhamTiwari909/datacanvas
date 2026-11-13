/**
 * What is actually SHOWN on the canvas: the result of applying the filters and
 * the focus mode to the tables and relationships that are on it.
 *
 * A pure function (no React, no stores) so every combination can be tested.
 *
 *   1. FILTERS decide which tables are visible at all (schemas, views, hidden tables).
 *   2. Relationship-type switches decide which edges exist.
 *   3. FOCUS (only when tables are selected and mode is not "off") walks the
 *      remaining graph from the selected tables, breadth-first, up to `hops`
 *      relationships, and either dims or hides everything it did not reach.
 */
import {
  filterEdges,
  reachableWithin,
  visibleNodeIds,
  type CanvasFilters,
  type EdgeDescriptor,
  type FilterableNode,
  type RelationshipTypeFilter,
} from "@datacanvas/canvas-engine";
import type { FocusState } from "@/stores/canvas-view-store";

export interface DisplayInput {
  nodes: readonly FilterableNode[];
  edges: readonly EdgeDescriptor[];
  selectedIds: readonly string[];
  filters: CanvasFilters;
  relationshipTypes: RelationshipTypeFilter;
  focus: FocusState;
}

export interface DisplayEdge {
  edge: EdgeDescriptor;
  /** Drawn faded because it lies outside the focus. */
  dimmed: boolean;
}

export interface DisplayResult {
  /** Tables that are not drawn at all (filtered out, or hidden by focus mode). */
  hiddenIds: Set<string>;
  /** Tables drawn faded (focus mode "dim"). */
  dimmedIds: Set<string>;
  edges: DisplayEdge[];
  /** True when focus is actually changing what is drawn (mode on AND something selected). */
  focusActive: boolean;
  /** Tables in focus with their distance from the selection; null when focus is not active. */
  reach: Map<string, number> | null;
}

export function computeDisplay(input: DisplayInput): DisplayResult {
  const visible = visibleNodeIds(input.nodes, input.filters);
  const edges = filterEdges(input.edges, visible, input.relationshipTypes);

  const roots = input.selectedIds.filter((id) => visible.has(id));
  const focusActive = input.focus.mode !== "off" && roots.length > 0;
  const reach = focusActive
    ? reachableWithin(roots, edges, input.focus.hops, input.focus.direction)
    : null;

  const hiddenIds = new Set<string>();
  const dimmedIds = new Set<string>();
  for (const node of input.nodes) {
    if (!visible.has(node.id)) hiddenIds.add(node.id);
    else if (reach && !reach.has(node.id))
      (input.focus.mode === "hide" ? hiddenIds : dimmedIds).add(node.id);
  }

  const shown: DisplayEdge[] = [];
  for (const edge of edges) {
    if (hiddenIds.has(edge.source) || hiddenIds.has(edge.target)) continue;
    // An edge is "in focus" when both of its ends are.
    const dimmed = reach !== null && !(reach.has(edge.source) && reach.has(edge.target));
    shown.push({ edge, dimmed });
  }
  return { hiddenIds, dimmedIds, edges: shown, focusActive, reach };
}
