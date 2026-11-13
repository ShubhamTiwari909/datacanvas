import type { SearchHit, SearchHitKind } from "@datacanvas/database-core";
import type { Queryable } from "./types.js";
import { excludeSystemSchemas } from "./system-schemas.js";
import { LISTED_RELKINDS, relationKindFromRelkind } from "./tables.js";

/**
 * Name search over the catalogs. Two queries (tables, then columns); each is
 * capped by `limit` so a one-letter query on a huge database stays cheap.
 *
 * - `strpos(lower(name), lower($1)) > 0` is a plain substring test. Unlike
 *   LIKE it has no wildcard characters, so a user typing "%" or "_" gets
 *   exactly what they typed, with no escaping to get wrong.
 * - The query text is a bound parameter: it is never part of the SQL string.
 * - ORDER BY ranks exact matches first, then names starting with the query,
 *   then the rest; `starts_with` needs PostgreSQL 11 or newer.
 * - Partitions are skipped (like in listings), system schemas are hidden, and
 *   only user-visible object kinds are searched.
 */
const RANK = (column: string) => `
  CASE WHEN lower(${column}) = lower($1) THEN 0
       WHEN starts_with(lower(${column}), lower($1)) THEN 1
       ELSE 2 END`;

const TABLES_SQL = `
  SELECT n.nspname::text AS schema, c.relname::text AS name, c.relkind::text AS relkind
  FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relkind = ANY ($2::"char"[])
    AND NOT c.relispartition
    AND ${excludeSystemSchemas("n.nspname")}
    AND strpos(lower(c.relname), lower($1)) > 0
  ORDER BY ${RANK("c.relname")}, n.nspname, c.relname
  LIMIT $3
`;

const COLUMNS_SQL = `
  SELECT n.nspname::text AS schema, c.relname::text AS "table", a.attname::text AS name,
         pg_catalog.format_type(a.atttypid, a.atttypmod) AS data_type
  FROM pg_catalog.pg_attribute a
  JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE a.attnum > 0
    AND NOT a.attisdropped
    AND c.relkind = ANY ($2::"char"[])
    AND NOT c.relispartition
    AND ${excludeSystemSchemas("n.nspname")}
    AND strpos(lower(a.attname), lower($1)) > 0
  ORDER BY ${RANK("a.attname")}, n.nspname, c.relname, a.attnum
  LIMIT $3
`;

/** The most hits of each kind a caller may ask for. */
export const MAX_SEARCH_LIMIT = 100;

export async function searchObjects(
  db: Queryable,
  query: string,
  limit: number,
): Promise<SearchHit[]> {
  const text = query.trim();
  if (text === "") return [];
  const cap = Math.min(Math.max(Math.trunc(limit), 1), MAX_SEARCH_LIMIT);

  const tables = await db.query<{ schema: string; name: string; relkind: string }>(TABLES_SQL, [
    text,
    LISTED_RELKINDS,
    cap,
  ]);
  const columns = await db.query<{
    schema: string;
    table: string;
    name: string;
    data_type: string;
  }>(COLUMNS_SQL, [text, LISTED_RELKINDS, cap]);

  return [
    ...tables.rows.map((row): SearchHit => ({
      kind: relationKindFromRelkind(row.relkind) satisfies SearchHitKind,
      schema: row.schema,
      table: row.name,
      column: null,
      dataType: null,
    })),
    ...columns.rows.map((row): SearchHit => ({
      kind: "column",
      schema: row.schema,
      table: row.table,
      column: row.name,
      dataType: row.data_type,
    })),
  ];
}
