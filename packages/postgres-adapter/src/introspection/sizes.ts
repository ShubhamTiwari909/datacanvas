import type { DatabaseSizes, TableSize } from "@datacanvas/database-core";
import { excludeSystemSchemas } from "./system-schemas.js";
import type { Queryable } from "./types.js";

/**
 * How much disk space the database, its user schemas and its largest tables take, from the server's size functions
 * (`pg_database_size`, `pg_total_relation_size`, `pg_table_size`, `pg_indexes_size`). These are FILE sizes: no row of
 * any table is read.
 *
 * - Tables, partitioned tables and materialized views (`relkind` r, p, m). A partition is not listed on its own: its size
 *   counts toward its partitioned parent (`pg_partition_tree`, PostgreSQL 12 and later), whose own size is zero.
 * - System schemas are left out, as everywhere else.
 * - Numbers are cast to float8 so the driver returns JavaScript numbers (it returns bigint as text).
 * - `$1` is the schema or NULL (every schema); `$2` is the number of tables, largest first. Both are parameters.
 */
const TABLES_SQL = `
  WITH sized AS (
    SELECT
      n.nspname::text AS schema,
      c.relname::text AS name,
      c.relkind::text AS relkind,
      c.reltuples::float8 AS estimated_rows,
      CASE WHEN c.relkind = 'p' THEN
        (SELECT COALESCE(SUM(pg_catalog.pg_total_relation_size(pt.relid)), 0) FROM pg_catalog.pg_partition_tree(c.oid) pt)
      ELSE pg_catalog.pg_total_relation_size(c.oid) END::float8 AS total_bytes,
      CASE WHEN c.relkind = 'p' THEN
        (SELECT COALESCE(SUM(pg_catalog.pg_table_size(pt.relid)), 0) FROM pg_catalog.pg_partition_tree(c.oid) pt)
      ELSE pg_catalog.pg_table_size(c.oid) END::float8 AS table_bytes,
      CASE WHEN c.relkind = 'p' THEN
        (SELECT COALESCE(SUM(pg_catalog.pg_indexes_size(pt.relid)), 0) FROM pg_catalog.pg_partition_tree(c.oid) pt)
      ELSE pg_catalog.pg_indexes_size(c.oid) END::float8 AS index_bytes
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r', 'p', 'm')
      AND NOT c.relispartition
      AND ${excludeSystemSchemas("n.nspname")}
      AND ($1::text IS NULL OR n.nspname = $1::text)
  )
  SELECT *, COUNT(*) OVER ()::float8 AS table_count
  FROM sized
  ORDER BY total_bytes DESC, schema, name
  LIMIT $2
`;

/** The total of each user schema (every table, not only the largest ones). */
const SCHEMAS_SQL = `
  SELECT
    n.nspname::text AS schema,
    COALESCE(SUM(pg_catalog.pg_total_relation_size(c.oid)), 0)::float8 AS total_bytes,
    COUNT(*) FILTER (WHERE NOT c.relispartition AND c.relkind IN ('r', 'p', 'm'))::float8 AS tables
  FROM pg_catalog.pg_namespace n
  LEFT JOIN pg_catalog.pg_class c
    ON c.relnamespace = n.oid AND c.relkind IN ('r', 'p', 'm')
  WHERE ${excludeSystemSchemas("n.nspname")}
    AND ($1::text IS NULL OR n.nspname = $1::text)
  GROUP BY n.nspname
  ORDER BY total_bytes DESC, n.nspname
`;

/** The whole database (catalogs included), or null when this role may not see it (it needs CONNECT on the database). */
const DATABASE_SQL = `SELECT pg_catalog.pg_database_size(pg_catalog.current_database())::float8 AS bytes`;

interface TableRow {
  schema: string;
  name: string;
  relkind: string;
  estimated_rows: number;
  total_bytes: number;
  table_bytes: number;
  index_bytes: number;
  table_count: number;
}

interface SchemaRow {
  schema: string;
  total_bytes: number;
  tables: number;
}

const KIND: Record<string, TableSize["kind"]> = {
  r: "table",
  p: "partitioned",
  m: "materialized",
};

export async function readSizes(
  db: Queryable,
  options: { schema?: string; limit: number },
): Promise<DatabaseSizes> {
  const schema = options.schema ?? null;
  const tables = await db.query<TableRow>(TABLES_SQL, [schema, options.limit]);
  const schemas = await db.query<SchemaRow>(SCHEMAS_SQL, [schema]);
  let databaseBytes: number | null = null;
  try {
    const database = await db.query<{ bytes: number }>(DATABASE_SQL);
    databaseBytes = database.rows[0]?.bytes ?? null;
  } catch {
    // A role without CONNECT on the database cannot ask its size: that is "not known", not an error of the call.
    databaseBytes = null;
  }
  return {
    databaseBytes,
    schemas: schemas.rows.map((r) => ({
      schema: r.schema,
      totalBytes: r.total_bytes,
      tables: r.tables,
    })),
    tables: tables.rows.map((r) => ({
      schema: r.schema,
      name: r.name,
      kind: KIND[r.relkind] ?? "table",
      totalBytes: r.total_bytes,
      tableBytes: r.table_bytes,
      indexBytes: r.index_bytes,
      // reltuples is -1 (PostgreSQL 14 and later) before the first ANALYZE: not a count.
      estimatedRows: r.estimated_rows < 0 ? null : r.estimated_rows,
    })),
    tableCount: tables.rows[0]?.table_count ?? 0,
  };
}
