import type { RelationKind, TableInfo } from "@datacanvas/database-core";
import type { Queryable } from "./types.js";

/**
 * pg_class holds every "relation": tables, views, indexes, sequences...
 * `relkind` says which: r = ordinary table, p = partitioned table (the parent),
 * v = view, m = materialized view. (Others, such as i = index or S = sequence,
 * are not tables; f = foreign table is not shown yet.)
 */
export const LISTED_RELKINDS = ["r", "p", "v", "m"];

/**
 * - JOIN pg_namespace: translate the numeric schema id into a name and filter by it.
 * - LEFT JOIN pg_description: the optional COMMENT ON text. `objsubid = 0`
 *   means "the table itself" (columns use their own number).
 * - NOT relispartition: hide the individual partitions of a partitioned table.
 *   A table split into 100 monthly partitions would otherwise bury the one
 *   logical table among 100 near-identical ones; the parent still appears.
 * - reltuples is the planner's row estimate, maintained by VACUUM/ANALYZE. It
 *   is read, never computed: counting rows would scan the table. It is cast to
 *   float8 so the driver returns a JS number (it returns bigint as a string).
 */
const TABLES_SQL = `
  SELECT
    n.nspname AS schema,
    c.relname AS name,
    c.relkind::text AS relkind,
    d.description AS comment,
    c.reltuples::float8 AS reltuples
  FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  LEFT JOIN pg_catalog.pg_description d
    ON d.objoid = c.oid
   AND d.classoid = 'pg_catalog.pg_class'::regclass
   AND d.objsubid = 0
  WHERE n.nspname = $1
    AND c.relkind = ANY ($2::"char"[])
    AND NOT c.relispartition
  ORDER BY c.relname
`;

interface TableRow {
  schema: string;
  name: string;
  relkind: string;
  comment: string | null;
  reltuples: number;
}

export function relationKindFromRelkind(relkind: string): RelationKind {
  switch (relkind) {
    case "v":
      return "view";
    case "m":
      return "materialized_view";
    default:
      return "table"; // "r" and "p"
  }
}

/**
 * Turn the planner's estimate into our model. -1 (PostgreSQL 14+) means "never
 * analysed", and views have no rows of their own, so both become null.
 */
export function estimatedRowCount(kind: RelationKind, reltuples: number): number | null {
  if (kind === "view" || reltuples < 0) return null;
  return Math.round(reltuples);
}

export async function listTables(db: Queryable, schema: string): Promise<TableInfo[]> {
  const { rows } = await db.query<TableRow>(TABLES_SQL, [schema, LISTED_RELKINDS]);
  return rows.map((row) => {
    const kind = relationKindFromRelkind(row.relkind);
    return {
      schema: row.schema,
      name: row.name,
      kind,
      comment: row.comment,
      estimatedRowCount: estimatedRowCount(kind, row.reltuples),
    };
  });
}
