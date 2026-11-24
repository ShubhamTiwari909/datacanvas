/**
 * Calls that read a connection's structure.
 */
import {
  indexUsageResponseSchema,
  objectsResponseSchema,
  relationshipsResponseSchema,
  schemasResponseSchema,
  searchResponseSchema,
  tableDetailsResponseSchema,
  tableStatisticsResponseSchema,
  tablesDetailsResponseSchema,
  tablesResponseSchema,
} from "@datacanvas/shared-types";
import type {
  ColumnInfo,
  ConstraintInfo,
  DatabaseObjects,
  IndexUsageReport,
  IndexInfo,
  RelationshipInfo,
  SchemaInfo,
  SearchHit,
  TableDetailsEntry,
  TableInfo,
  TableRef,
  TableStatistics,
} from "@datacanvas/database-core";
import { apiRequest, type ApiResult } from "@/lib/api-client";

const base = (connectionId: string): string =>
  `/api/connections/${encodeURIComponent(connectionId)}`;

/** Each function unwraps the response envelope so callers get the data itself. */
async function unwrap<T, R>(result: ApiResult<T>, pick: (data: T) => R): Promise<ApiResult<R>> {
  return result.ok ? { ok: true, data: pick(result.data) } : result;
}

export async function getSchemas(connectionId: string): Promise<ApiResult<SchemaInfo[]>> {
  const result = await apiRequest(`${base(connectionId)}/schemas`, schemasResponseSchema);
  return unwrap(result, (d) => d.schemas);
}

export async function getTables(
  connectionId: string,
  schema: string,
): Promise<ApiResult<TableInfo[]>> {
  const result = await apiRequest(
    `${base(connectionId)}/tables?schema=${encodeURIComponent(schema)}`,
    tablesResponseSchema,
  );
  return unwrap(result, (d) => d.tables);
}

export interface TableDetails {
  columns: ColumnInfo[];
  constraints: ConstraintInfo[];
  indexes: IndexInfo[];
}

export function getTableDetails(
  connectionId: string,
  schema: string,
  table: string,
): Promise<ApiResult<TableDetails>> {
  return apiRequest(
    `${base(connectionId)}/tables/${encodeURIComponent(table)}?schema=${encodeURIComponent(schema)}`,
    tableDetailsResponseSchema,
  );
}

export async function getRelationships(
  connectionId: string,
): Promise<ApiResult<RelationshipInfo[]>> {
  const result = await apiRequest(
    `${base(connectionId)}/relationships`,
    relationshipsResponseSchema,
  );
  return unwrap(result, (d) => d.relationships);
}

/** Many tables in one request (used by the canvas). Results follow the order of `tables`. */
export async function getTablesDetails(
  connectionId: string,
  tables: TableRef[],
): Promise<ApiResult<TableDetailsEntry[]>> {
  const result = await apiRequest(
    `${base(connectionId)}/table-details`,
    tablesDetailsResponseSchema,
    {
      method: "POST",
      body: { tables },
    },
  );
  return unwrap(result, (d) => d.tables);
}

/** Search table, view and column names across the whole database. */
export async function searchObjects(
  connectionId: string,
  query: string,
  limit = 8,
): Promise<ApiResult<SearchHit[]>> {
  const result = await apiRequest(
    `${base(connectionId)}/search?q=${encodeURIComponent(query)}&limit=${limit}`,
    searchResponseSchema,
  );
  return unwrap(result, (d) => d.hits);
}

/** Views (with definitions and what they read), types, sequences, functions, triggers, extensions and policies. */
export async function getObjects(connectionId: string): Promise<ApiResult<DatabaseObjects>> {
  const result = await apiRequest(`${base(connectionId)}/objects`, objectsResponseSchema);
  return unwrap(result, (d) => d.objects);
}

/** Usage counters of the indexes of the ordinary tables (statistics, not rows). */
export async function getIndexUsage(connectionId: string): Promise<ApiResult<IndexUsageReport>> {
  const result = await apiRequest(`${base(connectionId)}/index-usage`, indexUsageResponseSchema);
  return unwrap(result, (d) => d.usage);
}

/** What the server's statistics say about a table (no row, no value); null for a view or a foreign table. */
export async function getTableStatistics(
  connectionId: string,
  schema: string,
  table: string,
): Promise<ApiResult<TableStatistics | null>> {
  const result = await apiRequest(
    `${base(connectionId)}/tables/${encodeURIComponent(table)}/statistics?schema=${encodeURIComponent(schema)}`,
    tableStatisticsResponseSchema,
  );
  return unwrap(result, (d) => d.statistics);
}
