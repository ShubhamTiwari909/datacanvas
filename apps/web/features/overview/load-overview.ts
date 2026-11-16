/**
 * Fetch what the overview needs and compute it.
 *
 * This tab reads no table rows. It uses only structure the app already knows how to read: the table list of
 * every schema and the database's foreign keys (shared with the canvas through
 * the metadata cache, so opening the overview first makes the canvas faster,
 * and the other way round).
 */
import { loadAllTables } from "@/features/explorer/load-all-tables";
import type { ApiResult } from "@/lib/api-client";
import { useMetadataStore } from "@/stores/metadata-store";
import { computeDatabaseOverview, type DatabaseOverview } from "./schema-overview";

export async function loadDatabaseOverview(
  connectionId: string,
): Promise<ApiResult<DatabaseOverview>> {
  const [tables, relationshipsOutcome] = await Promise.all([
    loadAllTables(connectionId),
    useMetadataStore.getState().ensureRelationships(connectionId),
  ]);
  if (!tables.ok) return tables;
  if (!relationshipsOutcome.ok) {
    return {
      ok: false,
      error: { code: "unexpected", message: relationshipsOutcome.message, issues: [] },
    };
  }

  const relationships = useMetadataStore.getState().byConnection[connectionId]?.relationships ?? [];
  return { ok: true, data: computeDatabaseOverview(tables.data, relationships) };
}
