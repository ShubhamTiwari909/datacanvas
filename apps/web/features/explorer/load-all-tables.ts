/**
 * Read the table list of EVERY schema of a connection (one request per schema,
 * in parallel). Shared by the overview and the health checks.
 */
import type { TableInfo } from "@datacanvas/database-core";
import type { ApiResult } from "@/lib/api-client";
import { getSchemas, getTables } from "./api";

export interface SchemaTables {
  schema: string;
  tables: TableInfo[];
}

export async function loadAllTables(connectionId: string): Promise<ApiResult<SchemaTables[]>> {
  const schemas = await getSchemas(connectionId);
  if (!schemas.ok) return schemas;

  const lists = await Promise.all(
    schemas.data.map(async (s) => ({
      schema: s.name,
      result: await getTables(connectionId, s.name),
    })),
  );
  const loaded: SchemaTables[] = [];
  for (const { schema, result } of lists) {
    if (!result.ok) return result;
    loaded.push({ schema, tables: result.data });
  }
  return { ok: true, data: loaded };
}
