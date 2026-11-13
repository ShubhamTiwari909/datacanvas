/**
 * Putting a saved layout back on the canvas.
 *
 * The file stores only table NAMES and positions, so restoring has to look at
 * the database as it is NOW. A table that existed when the layout was saved may
 * have been renamed or dropped since. Such tables are not an error: they are
 * kept on the canvas as clearly marked "missing" cards (and stay in the saved
 * file), so a temporary difference (say, pointing the layout at a staging
 * database) loses nothing.
 */
import { tableRefKey } from "@datacanvas/database-core";
import type { Workspace } from "@datacanvas/shared-types";
import { getTables } from "@/features/explorer/api";
import { useCanvasStore, type RestoredNode } from "@/stores/canvas-store";
import { useMetadataStore } from "@/stores/metadata-store";
import { uniqueSavedNodes } from "./serialize";

export type RestoreResult = { ok: true; missing: number } | { ok: false; message: string };

export async function restoreWorkspace(
  connectionId: string,
  workspace: Workspace,
): Promise<RestoreResult> {
  const saved = uniqueSavedNodes(workspace.canvas.nodes);

  // 1. Which of the saved tables exist now? One cheap listing per schema, not one request per table.
  const existing = new Set<string>();
  for (const schema of new Set(saved.map((n) => n.schema))) {
    const listed = await getTables(connectionId, schema);
    if (listed.ok) {
      for (const table of listed.data)
        existing.add(tableRefKey({ schema: table.schema, name: table.name }));
    } else if (listed.error.code !== "not_found") {
      // "not_found" means the whole schema is gone (its tables become "missing"); anything else is a real failure.
      return { ok: false, message: listed.error.message };
    }
  }
  const isPresent = (n: { schema: string; name: string }): boolean =>
    existing.has(tableRefKey({ schema: n.schema, name: n.name }));

  // 2. Load the structure of the tables that exist, in one bulk request.
  const present = saved.filter(isPresent).map((n) => ({ schema: n.schema, name: n.name }));
  if (present.length > 0) {
    const metadata = useMetadataStore.getState();
    const [tables, relationships] = await Promise.all([
      metadata.ensureTables(connectionId, present),
      metadata.ensureRelationships(connectionId),
    ]);
    const failure = !tables.ok ? tables : !relationships.ok ? relationships : null;
    if (failure && !failure.ok) return { ok: false, message: failure.message };
  }

  // 3. Build the nodes: saved position and state for every table, flagged when it no longer exists.
  const cache = useMetadataStore.getState().byConnection[connectionId]?.tables ?? {};
  let missing = 0;
  const nodes: RestoredNode[] = saved.map((n) => {
    const ref = { schema: n.schema, name: n.name };
    const entry = cache[tableRefKey(ref)];
    const exists = isPresent(n) && entry !== undefined;
    if (!exists) missing += 1;
    return {
      ref,
      x: n.x,
      y: n.y,
      expanded: n.expanded,
      columnCount: entry?.columns.length ?? 0,
      missing: !exists,
    };
  });

  useCanvasStore.getState().restore(connectionId, nodes, workspace.canvas.viewport);
  return { ok: true, missing };
}
