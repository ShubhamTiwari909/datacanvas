import { tableRefKey, type IndexInfo, type TableRef } from "@datacanvas/database-core";
import type { Queryable } from "./types.js";
import { WANTED_CTE, groupByTable, wantedParams } from "./wanted.js";

/**
 * pg_index describes indexes; the index itself is also a row in pg_class
 * (`indexrelid`), which gives its name, and pg_am names its method (btree,
 * gin, hash, ...).
 *
 * - indnkeyatts is the number of real KEY columns. Columns added with
 *   INCLUDE (...) come after them and do not affect ordering or uniqueness,
 *   so we stop at indnkeyatts. (Needs PostgreSQL 11 or newer.)
 * - pg_get_indexdef(index, n, true) returns the text of the n-th key: the
 *   column name for a plain column, or the expression text for an expression
 *   index such as lower(email). That is why the model says columns can hold
 *   expressions.
 * - The unqualified pg_get_indexdef(index) is the full CREATE INDEX statement.
 * - Per table, the primary key's index is listed first.
 * - The JOIN against `wanted` (see wanted.ts) restricts the query to the
 *   requested tables.
 */
const INDEXES_SQL = `
  ${WANTED_CTE}
  SELECT
    n.nspname::text AS schema,
    t.relname::text AS "table",
    i.relname::text AS name,
    ARRAY(
      SELECT pg_catalog.pg_get_indexdef(ix.indexrelid, k.n::int, true)
      FROM generate_series(1, ix.indnkeyatts) AS k(n)
      ORDER BY k.n
    ) AS columns,
    ix.indisunique AS "unique",
    ix.indisprimary AS "primary",
    am.amname::text AS method,
    pg_catalog.pg_get_indexdef(ix.indexrelid) AS definition
  FROM pg_catalog.pg_index ix
  JOIN pg_catalog.pg_class t ON t.oid = ix.indrelid
  JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
  JOIN wanted w ON w.schema_name = n.nspname AND w.relation_name = t.relname
  JOIN pg_catalog.pg_class i ON i.oid = ix.indexrelid
  JOIN pg_catalog.pg_am am ON am.oid = i.relam
  ORDER BY n.nspname, t.relname, ix.indisprimary DESC, i.relname
`;

interface IndexRow {
  schema: string;
  table: string;
  name: string;
  columns: string[];
  unique: boolean;
  primary: boolean;
  method: string;
  definition: string | null;
}

export async function listIndexesFor(
  db: Queryable,
  tables: readonly TableRef[],
): Promise<Map<string, IndexInfo[]>> {
  const { refs, params } = wantedParams(tables);
  if (refs.length === 0) return new Map();
  const { rows } = await db.query<IndexRow>(INDEXES_SQL, params);
  return groupByTable(rows, (row) => ({
    name: row.name,
    columns: row.columns,
    unique: row.unique,
    primary: row.primary,
    method: row.method,
    definition: row.definition,
  }));
}

export async function listIndexes(
  db: Queryable,
  schema: string,
  table: string,
): Promise<IndexInfo[]> {
  const ref = { schema, name: table };
  return (await listIndexesFor(db, [ref])).get(tableRefKey(ref)) ?? [];
}
