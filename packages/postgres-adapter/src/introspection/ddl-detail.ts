import {
  normalizeDdl,
  type ColumnDdl,
  type CommentTarget,
  type ConstraintDdl,
  type DdlDetail,
  type ObjectComment,
  type TableDdl,
  type TableRef,
} from "@datacanvas/database-core";
import type { Queryable } from "./types.js";
import { WANTED_CTE, wantedParams } from "./wanted.js";

/**
 * The parts of a definition that a migration must say and that the structure of 1.0 to 1.6 did
 * not record (`docs/migration-studio-plan.md`, section 6). Sparse: only what is not the default.
 *
 * Every query joins the `wanted` list of tables, so one query serves any number of them, and each
 * reads catalog columns that exist in PostgreSQL 12 to 18 (`attgenerated` is new in 12, and its
 * value `v`, a virtual column, in 18).
 */

const COLUMNS_SQL = `
  ${WANTED_CTE}
  SELECT n.nspname::text AS schema, c.relname::text AS "table", a.attname::text AS name,
         a.attidentity::text AS identity, a.attgenerated::text AS generated,
         CASE WHEN a.attcollation <> 0 AND a.attcollation <> t.typcollation
              THEN co.collname::text END AS collation,
         CASE WHEN a.attcollation <> 0 AND a.attcollation <> t.typcollation
              THEN cn.nspname::text END AS collation_schema
  FROM pg_catalog.pg_attribute a
  JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  JOIN wanted w ON w.schema_name = n.nspname AND w.relation_name = c.relname
  JOIN pg_catalog.pg_type t ON t.oid = a.atttypid
  LEFT JOIN pg_catalog.pg_collation co ON co.oid = a.attcollation
  LEFT JOIN pg_catalog.pg_namespace cn ON cn.oid = co.collnamespace
  WHERE a.attnum > 0 AND NOT a.attisdropped
    AND (a.attidentity <> '' OR a.attgenerated <> ''
         OR (a.attcollation <> 0 AND a.attcollation <> t.typcollation))
  ORDER BY n.nspname, c.relname, a.attnum
`;

const CONSTRAINTS_SQL = `
  ${WANTED_CTE}
  SELECT n.nspname::text AS schema, c.relname::text AS "table", con.conname::text AS name,
         con.condeferrable AS deferrable, con.condeferred AS initially_deferred,
         con.convalidated AS validated, con.confmatchtype::text AS match
  FROM pg_catalog.pg_constraint con
  JOIN pg_catalog.pg_class c ON c.oid = con.conrelid
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  JOIN wanted w ON w.schema_name = n.nspname AND w.relation_name = c.relname
  WHERE con.conparentid = 0
    AND (con.condeferrable OR NOT con.convalidated OR (con.contype = 'f' AND con.confmatchtype <> 's'))
  ORDER BY n.nspname, c.relname, con.conname
`;

/**
 * The partitions of a partitioned table are not in the list of tables (the viewer shows the
 * parent), but a migration has to create them, so they are read with it: `pg_partition_tree`
 * gives every level below a wanted table.
 */
const TABLES_SQL = `
  WITH wanted(schema_name, relation_name) AS (
    SELECT * FROM unnest($1::text[], $2::text[])
  ),
  roots AS (
    SELECT c.oid
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    JOIN wanted w ON w.schema_name = n.nspname AND w.relation_name = c.relname
  ),
  rels AS (
    SELECT oid FROM roots
    UNION
    SELECT pt.relid FROM roots r CROSS JOIN LATERAL pg_catalog.pg_partition_tree(r.oid) pt WHERE pt.level > 0
  )
  SELECT n.nspname::text AS schema, c.relname::text AS name,
         (c.relpersistence = 'u') AS unlogged,
         CASE WHEN c.relkind = 'p' THEN pg_catalog.pg_get_partkeydef(c.oid) END AS partition_key,
         par.schema AS parent_schema, par.name AS parent_table,
         CASE WHEN c.relispartition THEN pg_catalog.pg_get_expr(c.relpartbound, c.oid) END AS bound,
         COALESCE(c.reloptions, '{}'::text[]) AS options,
         ts.spcname::text AS tablespace,
         (SELECT COALESCE(json_agg(json_build_object('schema', pn.nspname, 'table', pc.relname)
                                   ORDER BY i.inhseqno), '[]'::json)
            FROM pg_catalog.pg_inherits i
            JOIN pg_catalog.pg_class pc ON pc.oid = i.inhparent
            JOIN pg_catalog.pg_namespace pn ON pn.oid = pc.relnamespace
           WHERE i.inhrelid = c.oid AND NOT c.relispartition) AS inherits
  FROM pg_catalog.pg_class c
  JOIN rels ON rels.oid = c.oid
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  LEFT JOIN pg_catalog.pg_tablespace ts ON ts.oid = c.reltablespace AND c.reltablespace <> 0
  LEFT JOIN LATERAL (
    SELECT pn.nspname::text AS schema, pc.relname::text AS name
    FROM pg_catalog.pg_inherits i
    JOIN pg_catalog.pg_class pc ON pc.oid = i.inhparent
    JOIN pg_catalog.pg_namespace pn ON pn.oid = pc.relnamespace
    WHERE i.inhrelid = c.oid AND c.relispartition
  ) par ON true
  WHERE c.relkind IN ('r', 'p', 'm')
    AND (c.relpersistence = 'u' OR c.relkind = 'p' OR c.relispartition
         OR c.reloptions IS NOT NULL OR c.reltablespace <> 0
         OR EXISTS (SELECT 1 FROM pg_catalog.pg_inherits i WHERE i.inhrelid = c.oid AND NOT c.relispartition))
  ORDER BY n.nspname, c.relname
`;

/** Comments on what the structure does not carry: schemas, types and sequences (by schema), indexes and constraints (by table). */
const SCHEMA_COMMENTS_SQL = `
  SELECT 'schema'::text AS target, n.nspname::text AS schema, NULL::text AS "table", n.nspname::text AS name,
         pg_catalog.obj_description(n.oid, 'pg_namespace') AS comment
  FROM pg_catalog.pg_namespace n
  WHERE n.nspname = ANY($1::text[]) AND pg_catalog.obj_description(n.oid, 'pg_namespace') IS NOT NULL
  UNION ALL
  SELECT 'type', n.nspname::text, NULL, t.typname::text, pg_catalog.obj_description(t.oid, 'pg_type')
  FROM pg_catalog.pg_type t
  JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
  WHERE n.nspname = ANY($1::text[])
    AND (t.typtype IN ('e', 'd')
         OR (t.typtype = 'c' AND EXISTS (SELECT 1 FROM pg_catalog.pg_class r WHERE r.oid = t.typrelid AND r.relkind = 'c')))
    AND pg_catalog.obj_description(t.oid, 'pg_type') IS NOT NULL
  UNION ALL
  SELECT 'sequence', n.nspname::text, NULL, c.relname::text, pg_catalog.obj_description(c.oid, 'pg_class')
  FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = ANY($1::text[]) AND c.relkind = 'S'
    AND pg_catalog.obj_description(c.oid, 'pg_class') IS NOT NULL
`;

const TABLE_COMMENTS_SQL = `
  ${WANTED_CTE}
  SELECT 'index'::text AS target, n.nspname::text AS schema, tc.relname::text AS "table",
         ic.relname::text AS name, pg_catalog.obj_description(ic.oid, 'pg_class') AS comment
  FROM pg_catalog.pg_index i
  JOIN pg_catalog.pg_class ic ON ic.oid = i.indexrelid
  JOIN pg_catalog.pg_class tc ON tc.oid = i.indrelid
  JOIN pg_catalog.pg_namespace n ON n.oid = tc.relnamespace
  JOIN wanted w ON w.schema_name = n.nspname AND w.relation_name = tc.relname
  WHERE pg_catalog.obj_description(ic.oid, 'pg_class') IS NOT NULL
  UNION ALL
  SELECT 'constraint', n.nspname::text, c.relname::text, con.conname::text,
         pg_catalog.obj_description(con.oid, 'pg_constraint')
  FROM pg_catalog.pg_constraint con
  JOIN pg_catalog.pg_class c ON c.oid = con.conrelid
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  JOIN wanted w ON w.schema_name = n.nspname AND w.relation_name = c.relname
  WHERE con.conparentid = 0 AND pg_catalog.obj_description(con.oid, 'pg_constraint') IS NOT NULL
`;

interface ColumnRow {
  schema: string;
  table: string;
  name: string;
  identity: string;
  generated: string;
  collation: string | null;
  collation_schema: string | null;
}
interface ConstraintRow {
  schema: string;
  table: string;
  name: string;
  deferrable: boolean;
  initially_deferred: boolean;
  validated: boolean;
  match: string;
}
interface TableRow {
  schema: string;
  name: string;
  unlogged: boolean;
  partition_key: string | null;
  parent_schema: string | null;
  parent_table: string | null;
  bound: string | null;
  options: string[];
  tablespace: string | null;
  inherits: { schema: string; table: string }[];
}
interface CommentRow {
  target: CommentTarget;
  schema: string;
  table: string | null;
  name: string;
  comment: string;
}

export async function readDdlDetail(
  db: Queryable,
  tables: readonly TableRef[],
  schemas: readonly string[],
): Promise<DdlDetail> {
  const { rows: versionRows } = await db.query<{ version: number }>(
    "SELECT current_setting('server_version_num')::int AS version",
  );
  const serverVersion = Number(versionRows[0]?.version ?? 0);

  const { refs, params } = wantedParams(tables);
  const comments: ObjectComment[] = [];
  const columns: ColumnDdl[] = [];
  const constraints: ConstraintDdl[] = [];
  const tableDdl: TableDdl[] = [];

  if (refs.length > 0) {
    for (const row of (await db.query<ColumnRow>(COLUMNS_SQL, params)).rows) {
      columns.push({
        schema: row.schema,
        table: row.table,
        column: row.name,
        identity: row.identity === "a" ? "always" : row.identity === "d" ? "by_default" : null,
        generated: row.generated === "s" ? "stored" : row.generated === "v" ? "virtual" : null,
        collation: row.collation,
        collationSchema: row.collation_schema,
      });
    }
    for (const row of (await db.query<ConstraintRow>(CONSTRAINTS_SQL, params)).rows) {
      constraints.push({
        schema: row.schema,
        table: row.table,
        name: row.name,
        deferrable: row.deferrable,
        initiallyDeferred: row.initially_deferred,
        validated: row.validated,
        match: row.match === "f" ? "full" : row.match === "p" ? "partial" : null,
      });
    }
    for (const row of (await db.query<TableRow>(TABLES_SQL, params)).rows) {
      tableDdl.push({
        schema: row.schema,
        name: row.name,
        unlogged: row.unlogged,
        partitionKey: row.partition_key,
        partitionOf:
          row.parent_schema !== null && row.parent_table !== null && row.bound !== null
            ? { schema: row.parent_schema, table: row.parent_table, bound: row.bound }
            : null,
        inherits: row.inherits ?? [],
        options: row.options ?? [],
        tablespace: row.tablespace,
      });
    }
    for (const row of (await db.query<CommentRow>(TABLE_COMMENTS_SQL, params)).rows) {
      comments.push({ ...row });
    }
  }
  if (schemas.length > 0) {
    for (const row of (await db.query<CommentRow>(SCHEMA_COMMENTS_SQL, [[...schemas]])).rows) {
      comments.push({ ...row });
    }
  }
  return normalizeDdl({ serverVersion, columns, constraints, tables: tableDdl, comments });
}
