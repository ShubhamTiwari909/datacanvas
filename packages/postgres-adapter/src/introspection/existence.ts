/**
 * Existence checks used by the table-level methods, so a missing schema or
 * table is reported as a clear `not_found` error instead of an empty result
 * (an empty list would be ambiguous: "no columns" vs "no such table").
 *
 * Both use the same visibility rules as the listing queries, so a hidden
 * system schema such as pg_catalog is "not found" here too.
 */
import { DatabaseError } from "@datacanvas/database-core";
import type { Queryable } from "./types.js";
import { excludeSystemSchemas } from "./system-schemas.js";
import { LISTED_RELKINDS } from "./tables.js";

const SCHEMA_EXISTS_SQL = `
  SELECT 1
  FROM pg_catalog.pg_namespace
  WHERE nspname = $1 AND ${excludeSystemSchemas("nspname")}
`;

const RELATION_EXISTS_SQL = `
  SELECT 1
  FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = $1
    AND c.relname = $2
    AND c.relkind = ANY ($3::"char"[])
    AND ${excludeSystemSchemas("n.nspname")}
`;

export async function assertSchemaExists(db: Queryable, schema: string): Promise<void> {
  const { rows } = await db.query(SCHEMA_EXISTS_SQL, [schema]);
  if (rows.length === 0) throw new DatabaseError("not_found");
}

export async function assertRelationExists(
  db: Queryable,
  schema: string,
  table: string,
): Promise<void> {
  const { rows } = await db.query(RELATION_EXISTS_SQL, [schema, table, LISTED_RELKINDS]);
  if (rows.length === 0) throw new DatabaseError("not_found");
}
