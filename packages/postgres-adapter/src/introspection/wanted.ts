/**
 * Helpers for the "bulk" queries, which fetch metadata for MANY tables with a
 * fixed number of queries instead of a few queries per table.
 *
 * The trick: the list of wanted tables is passed as two parallel text arrays
 * (schemas and names) and turned into a small table inside the query with
 * `unnest($1::text[], $2::text[])`. The query then JOINs against that table, so
 * it is just as safe as a normal parameterised query (no values are ever
 * pasted into the SQL text), and PostgreSQL does one pass over the catalogs
 * whether 1 or 500 tables are wanted.
 */
import { tableRefKey, uniqueTableRefs, type TableRef } from "@datacanvas/database-core";

/**
 * SQL that defines `wanted(schema_name, relation_name)` from parameters $1 and $2.
 * Put it first in a query, then `JOIN wanted w ON w.schema_name = n.nspname AND w.relation_name = c.relname`.
 */
export const WANTED_CTE = `
  WITH wanted(schema_name, relation_name) AS (
    SELECT * FROM unnest($1::text[], $2::text[])
  )
`;

/**
 * Query parameters for `WANTED_CTE`. Duplicates are removed first: a repeated
 * table would otherwise make every JOIN return its rows twice.
 */
export function wantedParams(refs: readonly TableRef[]): {
  refs: TableRef[];
  params: [string[], string[]];
} {
  const unique = uniqueTableRefs(refs);
  return { refs: unique, params: [unique.map((r) => r.schema), unique.map((r) => r.name)] };
}

/** Rows that carry the table they belong to, as returned by every bulk query. */
export interface TableScopedRow {
  schema: string;
  table: string;
}

/** Group rows by table, keeping the row order inside each group. */
export function groupByTable<Row extends TableScopedRow, Item>(
  rows: readonly Row[],
  toItem: (row: Row) => Item,
): Map<string, Item[]> {
  const groups = new Map<string, Item[]>();
  for (const row of rows) {
    const key = tableRefKey({ schema: row.schema, name: row.table });
    const items = groups.get(key) ?? [];
    items.push(toItem(row));
    groups.set(key, items);
  }
  return groups;
}
