/**
 * What the path finder needs: every table (views have no foreign keys, so they
 * are left out) and the database's foreign keys. Both come from reads the app
 * already does; the foreign keys go through the metadata cache shared with the
 * canvas and the overview.
 */
import type { RelationshipInfo } from "@datacanvas/database-core";
import { loadAllTables } from "@/features/explorer/load-all-tables";
import type { ApiResult } from "@/lib/api-client";
import { useMetadataStore } from "@/stores/metadata-store";
import type { TableKey } from "./path-finder";

export interface PathData {
  tables: TableKey[];
  relationships: RelationshipInfo[];
}

export async function loadPathData(connectionId: string): Promise<ApiResult<PathData>> {
  const [listed, outcome] = await Promise.all([
    loadAllTables(connectionId),
    useMetadataStore.getState().ensureRelationships(connectionId),
  ]);
  if (!listed.ok) return listed;
  if (!outcome.ok) {
    return { ok: false, error: { code: "unexpected", message: outcome.message, issues: [] } };
  }
  const relationships = useMetadataStore.getState().byConnection[connectionId]?.relationships ?? [];
  const tables = listed.data
    .flatMap(({ schema, tables }) =>
      tables.filter((t) => t.kind === "table").map((t) => ({ schema, table: t.name })),
    )
    .sort((a, b) => a.schema.localeCompare(b.schema) || a.table.localeCompare(b.table));
  return { ok: true, data: { tables, relationships } };
}
