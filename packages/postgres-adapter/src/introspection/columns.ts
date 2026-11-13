import { tableRefKey, type ColumnInfo, type TableRef } from "@datacanvas/database-core";
import type { Queryable } from "./types.js";
import { WANTED_CTE, groupByTable, wantedParams } from "./wanted.js";

/**
 * pg_attribute has one row per column of every relation.
 *
 * - attnum > 0 skips system columns (ctid, xmin, ...), which have negative numbers.
 * - NOT attisdropped skips columns that were dropped (their rows stay behind).
 * - format_type() prints the type the way you would write it: "integer",
 *   "character varying(255)", "numeric(10,2)", "timestamp with time zone".
 * - Defaults live in a separate table, pg_attrdef, as a stored expression tree;
 *   pg_get_expr() turns it back into SQL text such as "now()".
 * - attnum can have gaps after DROP COLUMN, so the position we report is
 *   row_number() per table over attnum: always 1, 2, 3... in definition order.
 * - For views, attnotnull is false, so every view column reads as nullable.
 * - The JOIN against `wanted` (see wanted.ts) restricts the query to the
 *   requested tables, so one query serves any number of them.
 */
const COLUMNS_SQL = `
  ${WANTED_CTE}
  SELECT
    n.nspname::text AS schema,
    c.relname::text AS "table",
    a.attname::text AS name,
    (row_number() OVER (PARTITION BY a.attrelid ORDER BY a.attnum))::int AS ordinal,
    pg_catalog.format_type(a.atttypid, a.atttypmod) AS data_type,
    NOT a.attnotnull AS nullable,
    pg_catalog.pg_get_expr(ad.adbin, ad.adrelid) AS default_value,
    d.description AS comment
  FROM pg_catalog.pg_attribute a
  JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  JOIN wanted w ON w.schema_name = n.nspname AND w.relation_name = c.relname
  LEFT JOIN pg_catalog.pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
  LEFT JOIN pg_catalog.pg_description d
    ON d.objoid = a.attrelid
   AND d.classoid = 'pg_catalog.pg_class'::regclass
   AND d.objsubid = a.attnum
  WHERE a.attnum > 0
    AND NOT a.attisdropped
  ORDER BY n.nspname, c.relname, a.attnum
`;

interface ColumnRow {
  schema: string;
  table: string;
  name: string;
  ordinal: number;
  data_type: string;
  nullable: boolean;
  default_value: string | null;
  comment: string | null;
}

/** Columns of several tables, grouped by `tableRefKey`. A table with no result simply has no entry. */
export async function listColumnsFor(
  db: Queryable,
  tables: readonly TableRef[],
): Promise<Map<string, ColumnInfo[]>> {
  const { refs, params } = wantedParams(tables);
  if (refs.length === 0) return new Map();
  const { rows } = await db.query<ColumnRow>(COLUMNS_SQL, params);
  return groupByTable(rows, (row) => ({
    name: row.name,
    ordinalPosition: row.ordinal,
    dataType: row.data_type,
    nullable: row.nullable,
    defaultValue: row.default_value,
    comment: row.comment,
  }));
}

export async function listColumns(
  db: Queryable,
  schema: string,
  table: string,
): Promise<ColumnInfo[]> {
  const ref = { schema, name: table };
  return (await listColumnsFor(db, [ref])).get(tableRefKey(ref)) ?? [];
}
