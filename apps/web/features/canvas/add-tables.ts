/**
 * "Put these tables on the canvas": the small workflow that ties the two stores
 * and the API together.
 *
 *   1. fetch whatever structure is missing (one bulk request) plus the
 *      relationships (once per connection);
 *   2. only then create the nodes, so a node is never drawn without its columns;
 *   3. report progress and any error through the canvas store.
 */
import { tableRefKey, type TableRef } from "@datacanvas/database-core";
import { getTables } from "@/features/explorer/api";
import { useCanvasStore } from "@/stores/canvas-store";
import { useMetadataStore } from "@/stores/metadata-store";

/** Adding a whole schema is capped so one click cannot freeze the browser with thousands of nodes. */
export const MAX_TABLES_ADDED_AT_ONCE = 200;

export async function addTablesToCanvas(
  connectionId: string,
  refs: TableRef[],
  options: { focus?: boolean } = {},
): Promise<boolean> {
  const canvas = useCanvasStore.getState();
  canvas.setStatus({ busy: true, error: null });

  const metadata = useMetadataStore.getState();
  const [tables, relationships] = await Promise.all([
    metadata.ensureTables(connectionId, refs),
    metadata.ensureRelationships(connectionId),
  ]);
  const failure = !tables.ok ? tables : !relationships.ok ? relationships : null;
  if (failure && !failure.ok) {
    useCanvasStore.getState().setStatus({ busy: false, error: failure.message });
    return false;
  }

  const cached = useMetadataStore.getState().byConnection[connectionId]?.tables ?? {};
  const items = refs.flatMap((ref) => {
    const entry = cached[tableRefKey(ref)];
    return entry ? [{ ref, columnCount: entry.columns.length }] : [];
  });

  const store = useCanvasStore.getState();
  store.addTables(connectionId, items);
  store.setStatus({ busy: false, error: null });

  const first = items[0];
  if (options.focus && first) store.requestFocus(connectionId, tableRefKey(first.ref));
  return true;
}

/** Add every table, view and materialized view of a schema (up to the cap). */
export async function addSchemaToCanvas(connectionId: string, schema: string): Promise<boolean> {
  useCanvasStore.getState().setStatus({ busy: true, error: null });
  const listed = await getTables(connectionId, schema);
  if (!listed.ok) {
    useCanvasStore.getState().setStatus({ busy: false, error: listed.error.message });
    return false;
  }

  const refs = listed.data
    .slice(0, MAX_TABLES_ADDED_AT_ONCE)
    .map((t) => ({ schema: t.schema, name: t.name }));
  const ok = await addTablesToCanvas(connectionId, refs);
  if (ok && listed.data.length > MAX_TABLES_ADDED_AT_ONCE) {
    useCanvasStore.getState().setStatus({
      busy: false,
      error: `"${schema}" has ${listed.data.length} tables; the first ${MAX_TABLES_ADDED_AT_ONCE} were added. Add the others one by one.`,
    });
  }
  return ok;
}
