/**
 * Exploring relationships: bring in the tables connected to the ones selected.
 */
import {
  parseNodeId,
  reachableWithin,
  relationshipEdges,
  type Direction,
} from "@datacanvas/canvas-engine";
import type { RelationshipInfo, TableRef } from "@datacanvas/database-core";
import { useCanvasStore } from "@/stores/canvas-store";
import { useMetadataStore } from "@/stores/metadata-store";
import { addTablesToCanvas } from "./add-tables";

/** One click never adds more than this many tables, so exploring a hub table cannot flood the canvas. */
export const MAX_RELATED_ADDED = 60;

/**
 * Which tables to add: those within `hops` relationships of the selection (in the
 * chosen direction) that are not on the canvas yet, nearest first.
 *
 * Pure: the walk is a breadth-first search over ALL of the database's
 * relationships (not only the ones between tables already shown).
 */
export function relatedTablesToAdd(
  selectedIds: readonly string[],
  onCanvasIds: ReadonlySet<string>,
  relationships: readonly RelationshipInfo[],
  hops: number,
  direction: Direction,
  cap: number = MAX_RELATED_ADDED,
): { refs: TableRef[]; found: number } {
  const reach = reachableWithin(selectedIds, relationshipEdges(relationships), hops, direction);
  const candidates = [...reach]
    .filter(([id]) => !onCanvasIds.has(id))
    .sort(([idA, a], [idB, b]) => a - b || idA.localeCompare(idB)); // nearest first, then by name
  const refs = candidates.flatMap(([id]) => {
    const ref = parseNodeId(id);
    return ref ? [ref] : [];
  });
  return { refs: refs.slice(0, cap), found: refs.length };
}

export type AddRelatedResult =
  { ok: true; added: number; found: number } | { ok: false; message: string };

/** Add the tables related to the selected ones to the canvas. */
export async function addRelatedTables(
  connectionId: string,
  options: { hops: number; direction: Direction },
): Promise<AddRelatedResult> {
  const nodes = useCanvasStore.getState().canvases[connectionId]?.nodes ?? [];
  const selected = nodes.filter((n) => n.selected).map((n) => n.id);
  if (selected.length === 0) return { ok: false, message: "Select a table first." };

  const loaded = await useMetadataStore.getState().ensureRelationships(connectionId);
  if (!loaded.ok) return { ok: false, message: loaded.message };

  const relationships = useMetadataStore.getState().byConnection[connectionId]?.relationships ?? [];
  const { refs, found } = relatedTablesToAdd(
    selected,
    new Set(nodes.map((n) => n.id)),
    relationships,
    options.hops,
    options.direction,
  );
  if (refs.length === 0) return { ok: true, added: 0, found: 0 };

  const ok = await addTablesToCanvas(connectionId, refs);
  return ok
    ? { ok: true, added: refs.length, found }
    : { ok: false, message: useCanvasStore.getState().error ?? "Could not add the tables." };
}
