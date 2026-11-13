/**
 * Which tables and relationships are shown. Pure functions: the UI keeps the
 * filter settings, this decides what they mean.
 */
import type { Cardinality, RelationKind } from "@datacanvas/database-core";

export interface FilterableNode {
  id: string;
  schema: string;
  /** null while the table's structure has not been loaded yet; such a table is never hidden by the "views" filter. */
  kind: RelationKind | null;
}

export interface CanvasFilters {
  /** Tables of these schemas are hidden. */
  hiddenSchemas: readonly string[];
  /** When false, views and materialized views are hidden. */
  showViews: boolean;
  /** Individually hidden tables (by node id). */
  hiddenIds: readonly string[];
}

export const DEFAULT_FILTERS: CanvasFilters = { hiddenSchemas: [], showViews: true, hiddenIds: [] };

/** Which kinds of relationship are drawn. */
export interface RelationshipTypeFilter {
  manyToOne: boolean;
  oneToOne: boolean;
}

export const ALL_RELATIONSHIP_TYPES: RelationshipTypeFilter = { manyToOne: true, oneToOne: true };

/** Ids of the nodes that pass every filter. */
export function visibleNodeIds(
  nodes: readonly FilterableNode[],
  filters: CanvasFilters,
): Set<string> {
  const hiddenSchemas = new Set(filters.hiddenSchemas);
  const hiddenIds = new Set(filters.hiddenIds);
  const visible = new Set<string>();
  for (const node of nodes) {
    if (hiddenIds.has(node.id)) continue;
    if (hiddenSchemas.has(node.schema)) continue;
    if (!filters.showViews && (node.kind === "view" || node.kind === "materialized_view")) continue;
    visible.add(node.id);
  }
  return visible;
}

/** Edges whose two ends are both visible and whose relationship type is switched on. */
export function filterEdges<T extends { source: string; target: string; cardinality: Cardinality }>(
  edges: readonly T[],
  visible: ReadonlySet<string>,
  types: RelationshipTypeFilter,
): T[] {
  return edges.filter((edge) => {
    if (!visible.has(edge.source) || !visible.has(edge.target)) return false;
    return edge.cardinality === "one-to-one" ? types.oneToOne : types.manyToOne;
  });
}
