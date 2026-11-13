import {
  tableRefKey,
  type ConstraintInfo,
  type ConstraintKind,
  type TableRef,
} from "@datacanvas/database-core";
import type { Queryable } from "./types.js";
import { WANTED_CTE, groupByTable, wantedParams } from "./wanted.js";

/**
 * pg_constraint has one row per constraint. `contype` is the kind:
 * p = primary key, u = unique, f = foreign key, c = check. (x = exclusion and
 * n = not-null, added in PostgreSQL 18, are not reported; nullability is
 * already on each column.)
 *
 * - conkey is an array of column NUMBERS (attnum). To get names we unnest the
 *   array WITH ORDINALITY (which numbers each element so we can keep the
 *   constraint's own column order) and join pg_attribute.
 * - attname has the SQL type "name", and the driver cannot parse arrays of
 *   that type, so it is cast to text to get a proper JS string array.
 * - pg_get_constraintdef() prints the constraint as SQL, e.g.
 *   "FOREIGN KEY (user_id) REFERENCES users(id)".
 * - conparentid = 0: a constraint on a partitioned table is copied onto every
 *   partition (the copies point at the original via conparentid). We only
 *   want the original.
 * - The ORDER BY lists, per table, the primary key first, then unique,
 *   foreign key, check.
 * - The JOIN against `wanted` (see wanted.ts) restricts the query to the
 *   requested tables.
 */
const CONSTRAINTS_SQL = `
  ${WANTED_CTE}
  SELECT
    n.nspname::text AS schema,
    c.relname::text AS "table",
    con.conname::text AS name,
    con.contype::text AS contype,
    ARRAY(
      SELECT a.attname::text
      FROM unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord)
      JOIN pg_catalog.pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum
      ORDER BY k.ord
    ) AS columns,
    pg_catalog.pg_get_constraintdef(con.oid) AS definition
  FROM pg_catalog.pg_constraint con
  JOIN pg_catalog.pg_class c ON c.oid = con.conrelid
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  JOIN wanted w ON w.schema_name = n.nspname AND w.relation_name = c.relname
  WHERE con.contype IN ('p', 'u', 'f', 'c')
    AND con.conparentid = 0
  ORDER BY n.nspname, c.relname,
           array_position(ARRAY['p', 'u', 'f', 'c'], con.contype::text), con.conname
`;

interface ConstraintRow {
  schema: string;
  table: string;
  name: string;
  contype: string;
  columns: string[];
  definition: string | null;
}

const KINDS: Record<string, ConstraintKind> = {
  p: "primary_key",
  u: "unique",
  f: "foreign_key",
  c: "check",
};

export async function listConstraintsFor(
  db: Queryable,
  tables: readonly TableRef[],
): Promise<Map<string, ConstraintInfo[]>> {
  const { refs, params } = wantedParams(tables);
  if (refs.length === 0) return new Map();
  const { rows } = await db.query<ConstraintRow>(CONSTRAINTS_SQL, params);
  // The WHERE clause only lets known kinds through, so unknown kinds cannot occur;
  // dropping them here is a safety net, not an expected path.
  return groupByTable(
    rows.filter((row) => KINDS[row.contype] !== undefined),
    (row) => ({
      name: row.name,
      kind: KINDS[row.contype] as ConstraintKind,
      columns: row.columns,
      definition: row.definition,
    }),
  );
}

export async function listConstraints(
  db: Queryable,
  schema: string,
  table: string,
): Promise<ConstraintInfo[]> {
  const ref = { schema, name: table };
  return (await listConstraintsFor(db, [ref])).get(tableRefKey(ref)) ?? [];
}
