import type { SchemaInfo } from "@datacanvas/database-core";
import type { Queryable } from "./types.js";
import { excludeSystemSchemas } from "./system-schemas.js";

/**
 * pg_namespace is the catalog table that lists schemas. Each row's `nspname`
 * is the schema name.
 */
const SCHEMAS_SQL = `
  SELECT nspname AS name
  FROM pg_catalog.pg_namespace
  WHERE ${excludeSystemSchemas("nspname")}
  ORDER BY nspname
`;

export async function listSchemas(db: Queryable): Promise<SchemaInfo[]> {
  const { rows } = await db.query<{ name: string }>(SCHEMAS_SQL);
  return rows.map((row) => ({ name: row.name }));
}
