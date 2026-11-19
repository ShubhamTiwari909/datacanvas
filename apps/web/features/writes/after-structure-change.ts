/**
 * What the app does after a change of structure was applied: the structure
 * counter goes up (the schema tree, its search and the table details read
 * again), the cached metadata of the changed table is refreshed for the canvas,
 * and a dropped or renamed table leaves the canvas and the selection.
 */
import { tableRefKey, type Change, type TableRef } from "@datacanvas/database-core";
import { addTablesToCanvas } from "@/features/canvas/add-tables";
import { invalidateCatalog } from "@/features/sql/completion/catalog-cache";
import { useCanvasStore } from "@/stores/canvas-store";
import { useMetadataStore } from "@/stores/metadata-store";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { useWritesStore } from "@/stores/writes-store";

/** Which tables a change of structure makes stale, and which no longer exist. */
export function affectedTables(change: Change): {
  reload: TableRef[];
  gone: TableRef | null;
  renamedTo: TableRef | null;
} {
  switch (change.kind) {
    case "update_row":
    case "insert_row":
    case "delete_row":
    case "create_table":
      return { reload: [], gone: null, renamedTo: null };
    case "drop_table":
      return { reload: [], gone: change.table, renamedTo: null };
    case "rename_table":
      return {
        reload: [],
        gone: change.table,
        renamedTo: { schema: change.table.schema, name: change.to },
      };
    case "add_foreign_key":
      return {
        reload: [
          change.table,
          {
            schema: change.foreignKey.references.schema,
            name: change.foreignKey.references.table,
          },
        ],
        gone: null,
        renamedTo: null,
      };
    default:
      return { reload: [change.table], gone: null, renamedTo: null };
  }
}

export async function afterStructureChange(connectionId: string, change: Change): Promise<void> {
  useWritesStore.getState().bumpStructure(connectionId);
  // The SQL view's completion reads the names again the next time it is asked.
  invalidateCatalog(connectionId);
  const { reload, gone, renamedTo } = affectedTables(change);

  let wasOnCanvas = false;
  if (gone) {
    const id = tableRefKey(gone);
    const canvas = useCanvasStore.getState();
    wasOnCanvas = canvas.canvases[connectionId]?.nodes.some((n) => n.id === id) ?? false;
    // A dropped table leaves the canvas now. A renamed one stays, and is renamed in place below,
    // once the metadata under its new name is loaded (a node is never drawn without its columns).
    if (wasOnCanvas && !renamedTo) canvas.applyChanges(connectionId, [{ type: "remove", id }]);

    const workspace = useWorkspaceStore.getState();
    const selected = workspace.selectedTable;
    if (
      workspace.selectedConnectionId === connectionId &&
      selected?.schema === gone.schema &&
      selected.name === gone.name
    ) {
      workspace.selectTable(renamedTo);
    }
  }

  if (renamedTo && wasOnCanvas && gone) {
    // Done before the old entry is dropped, so the node never lacks its columns. Only the node's
    // identity changes: its position, size and view state stay.
    const loaded = await useMetadataStore.getState().ensureTables(connectionId, [renamedTo]);
    if (loaded.ok) {
      useCanvasStore.getState().renameNode(connectionId, gone, renamedTo);
    } else {
      // Could not read the renamed table: take the old node off and let adding it report why.
      useCanvasStore
        .getState()
        .applyChanges(connectionId, [{ type: "remove", id: tableRefKey(gone) }]);
      await addTablesToCanvas(connectionId, [renamedTo]);
    }
  }

  await useMetadataStore
    .getState()
    .refreshAfterChange(connectionId, { reload, drop: gone ? [gone] : [] });
}
