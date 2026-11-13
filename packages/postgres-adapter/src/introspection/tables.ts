import type { RelationKind, TableInfo, TableRef } from "@datacanvas/database-core";
import type { Queryable } from "./types.js";
import { excludeSystemSchemas } from "./system-schemas.js";
import { WANTED_CTE, wantedParams } from "./wanted.js";

/**
 * pg_class holds every "relation": tables, views, indexes, sequences...
 * `relkind` says which: r = ordinary table, p = partitioned table (the parent),
 * v = view, m = materialized view, f = foreign table (rows live elsewhere, for
 * example behind postgres_fdw). Others, such as i = index or S = sequence, are
 * not tables and are not listed.
 */
export const LISTED_RELKINDS = ["r", "p", "v", "m", "f"];

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
    case "f":
      return "foreign_table";
    default:
      return "table"; // "r" and "p"
  }
}

/**
 * Turn the planner's estimate into our model. -1 (PostgreSQL 14+) means "never
 * analysed", and views have no rows of their own, so both become null. A
 * foreign table that was never analysed reports 0 (or -1), and 0 cannot be told
 * from "really empty" without reading the remote side, so for foreign tables a
 * zero also means unknown.
 */
export function estimatedRowCount(kind: RelationKind, reltuples: number): number | null {
  if (kind === "view" || reltuples < 0) return null;
  if (kind === "foreign_table" && reltuples === 0) return null;
  return Math.round(reltuples);
}

function toTableInfo(row: TableRow): TableInfo {
  const kind = relationKindFromRelkind(row.relkind);
  return {
    schema: row.schema,
    name: row.name,
    kind,
    comment: row.comment,
    estimatedRowCount: estimatedRowCount(kind, row.reltuples),
  };
}

export async function listTables(db: Queryable, schema: string): Promise<TableInfo[]> {
  const { rows } = await db.query<TableRow>(TABLES_SQL, [schema, LISTED_RELKINDS]);
  return rows.map(toTableInfo);
}

/**
 * Same description as `listTables`, but for specific tables chosen by name
 * (see wanted.ts). Differences: it does NOT hide partitions, because someone
 * who asks for a partition by name should get it; and tables that do not
 * exist are simply absent from the result, which is how callers detect
 * "not found". System schemas stay hidden, as everywhere.
 */
const TABLES_BY_REF_SQL = `
  ${WANTED_CTE}
  SELECT
    n.nspname AS schema,
    c.relname AS name,
    c.relkind::text AS relkind,
    d.description AS comment,
    c.reltuples::float8 AS reltuples
  FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  JOIN wanted w ON w.schema_name = n.nspname AND w.relation_name = c.relname
  LEFT JOIN pg_catalog.pg_description d
    ON d.objoid = c.oid
   AND d.classoid = 'pg_catalog.pg_class'::regclass
   AND d.objsubid = 0
  WHERE c.relkind = ANY ($3::"char"[])
    AND ${excludeSystemSchemas("n.nspname")}
`;

export async function listTablesByRef(
  db: Queryable,
  tables: readonly TableRef[],
): Promise<TableInfo[]> {
  const { refs, params } = wantedParams(tables);
  if (refs.length === 0) return [];
  const { rows } = await db.query<TableRow>(TABLES_BY_REF_SQL, [...params, LISTED_RELKINDS]);
  return rows.map(toTableInfo);
}
