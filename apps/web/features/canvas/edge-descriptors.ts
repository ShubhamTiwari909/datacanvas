/**
 * Computing the edge descriptors for the tables on a canvas. Shared by the hook
 * that draws edges and by the automatic layout, which needs the same graph.
 */
import { buildEdges, type EdgeDescriptor, type EdgeNode } from "@datacanvas/canvas-engine";
import type { RelationshipInfo, TableDetailsEntry } from "@datacanvas/database-core";

/** One table on the canvas, as a JSON string `[schema, name, expanded]` (cheap to compare, see use-canvas-display). */
export type NodeSpec = string;

export const nodeSpec = (schema: string, name: string, expanded: boolean): NodeSpec =>
  JSON.stringify([schema, name, expanded]);

export function describeEdges(
  specs: readonly NodeSpec[],
  tables: Readonly<Record<string, TableDetailsEntry>> | undefined,
  relationships: readonly RelationshipInfo[],
): EdgeDescriptor[] {
  const nodes = specs.flatMap((spec): EdgeNode[] => {
    const [schema, name, expanded] = JSON.parse(spec) as [string, string, boolean];
    const entry = tables?.[JSON.stringify([schema, name])]; // same key as database-core's tableRefKey
    return entry ? [{ schema, name, expanded, columns: entry.columns.map((c) => c.name) }] : [];
  });
  return buildEdges(relationships, nodes);
}
