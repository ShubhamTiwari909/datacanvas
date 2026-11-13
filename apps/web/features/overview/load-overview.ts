/**
 * Fetch what the overview needs and compute it.
 *
 * Reads only structure the app already knows how to read: the schema list, the
 * table list of every schema (one request each, in parallel) and the database's
 * foreign keys (shared with the canvas through the metadata cache, so opening
 * the overview first makes the canvas faster, and the other way round).
 */
import { getSchemas, getTables } from "@/features/explorer/api";
import type { ApiResult } from "@/lib/api-client";
import { useMetadataStore } from "@/stores/metadata-store";
import { computeDatabaseOverview, type DatabaseOverview } from "./schema-overview";

export async function loadDatabaseOverview(
  connectionId: string,
): Promise<ApiResult<DatabaseOverview>> {
  const schemas = await getSchemas(connectionId);
  if (!schemas.ok) return schemas;

  const [lists, relationshipsOutcome] = await Promise.all([
    Promise.all(
      schemas.data.map(async (s) => ({
        schema: s.name,
        result: await getTables(connectionId, s.name),
      })),
    ),
    useMetadataStore.getState().ensureRelationships(connectionId),
  ]);

  for (const { result } of lists) {
    if (!result.ok) return result;
  }
  if (!relationshipsOutcome.ok) {
    return {
      ok: false,
      error: { code: "unexpected", message: relationshipsOutcome.message, issues: [] },
    };
  }

  const relationships = useMetadataStore.getState().byConnection[connectionId]?.relationships ?? [];
  return {
    ok: true,
    data: computeDatabaseOverview(
      lists.flatMap(({ schema, result }) => (result.ok ? [{ schema, tables: result.data }] : [])),
      relationships,
    ),
  };
}
