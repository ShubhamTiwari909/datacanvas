/**
 * Turning relationships into the edges drawn between table nodes.
 *
 * Edges are a pure function of (relationships, tables currently on the canvas),
 * so they are never stored: add or remove a table and the right edges appear
 * or disappear by themselves, with nothing to keep in sync.
 */
import type { Cardinality, RelationshipInfo } from "@datacanvas/database-core";
import { visibleColumns } from "./columns.js";
import { columnHandleId, nodeIdFor, tableHandleId } from "./ids.js";

/** What edge building needs to know about a table that is on the canvas. */
export interface EdgeNode {
  schema: string;
  name: string;
  /** All column names, in order. */
  columns: readonly string[];
  expanded: boolean;
}

export interface EdgeDescriptor {
  id: string;
  /** Node ids. */
  source: string;
  target: string;
  sourceHandle: string;
  targetHandle: string;
  /** The foreign key's constraint name. */
  relationship: string;
  cardinality: Cardinality;
  /** Short marker drawn on the edge: "N:1" or "1:1". */
  label: string;
}

/** "many-to-one" -> "N:1" (many source rows per target row), "one-to-one" -> "1:1". */
export function cardinalityLabel(cardinality: Cardinality): string {
  return cardinality === "one-to-one" ? "1:1" : "N:1";
}

/**
 * One edge per foreign key whose BOTH tables are on the canvas.
 *
 * Each end attaches to the row of the foreign key's (first) column. If that row
 * is hidden because the table is collapsed, the edge attaches to the table
 * header instead, so it is still drawn rather than silently dropped.
 */
export function buildEdges(
  relationships: readonly RelationshipInfo[],
  nodes: readonly EdgeNode[],
): EdgeDescriptor[] {
  const byId = new Map(
    nodes.map((node) => [nodeIdFor({ schema: node.schema, name: node.name }), node]),
  );

  const edges: EdgeDescriptor[] = [];
  for (const relationship of relationships) {
    const source = nodeIdFor({
      schema: relationship.source.schema,
      name: relationship.source.table,
    });
    const target = nodeIdFor({
      schema: relationship.target.schema,
      name: relationship.target.table,
    });
    const sourceNode = byId.get(source);
    const targetNode = byId.get(target);
    if (!sourceNode || !targetNode) continue;

    const handleFor = (
      node: EdgeNode,
      columns: readonly string[],
      side: "source" | "target",
    ): string => {
      const column = columns[0];
      const shown =
        column !== undefined && visibleColumns(node.columns, node.expanded).includes(column);
      return shown ? columnHandleId(side, column) : tableHandleId(side);
    };

    edges.push({
      // A constraint name is unique per table, so source node + name identifies the edge.
      id: `${source}|${relationship.name}`,
      source,
      target,
      sourceHandle: handleFor(sourceNode, relationship.source.columns, "source"),
      targetHandle: handleFor(targetNode, relationship.target.columns, "target"),
      relationship: relationship.name,
      cardinality: relationship.cardinality,
      label: cardinalityLabel(relationship.cardinality),
    });
  }
  return edges;
}
