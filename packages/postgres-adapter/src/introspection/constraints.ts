import type { ConstraintInfo, ConstraintKind } from "@datacanvas/database-core";
import type { Queryable } from "./types.js";

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
 * - The ORDER BY lists the primary key first, then unique, foreign key, check.
 */
const CONSTRAINTS_SQL = `
  SELECT
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
  WHERE n.nspname = $1
    AND c.relname = $2
    AND con.contype IN ('p', 'u', 'f', 'c')
    AND con.conparentid = 0
  ORDER BY array_position(ARRAY['p', 'u', 'f', 'c'], con.contype::text), con.conname
`;

interface ConstraintRow {
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

export async function listConstraints(
  db: Queryable,
  schema: string,
  table: string,
): Promise<ConstraintInfo[]> {
  const { rows } = await db.query<ConstraintRow>(CONSTRAINTS_SQL, [schema, table]);
  return rows.flatMap((row) => {
    const kind = KINDS[row.contype];
    // The WHERE clause only lets known kinds through, so this is a safety net.
    return kind === undefined
      ? []
      : [{ name: row.name, kind, columns: row.columns, definition: row.definition }];
  });
}
