/**
 * Catalog lookups for the write path. Every query is fixed text with bound
 * parameters; names travel as parameters and are compared with the catalog,
 * so a change can only ever name things that exist. Nothing here reads a row.
 */
import type { IdentityKind, IncomingForeignKey, TableRef } from "@datacanvas/database-core";
import { referentialAction } from "../introspection/relationships.js";
import { excludeSystemSchemas } from "../introspection/system-schemas.js";
import { LISTED_RELKINDS } from "../introspection/tables.js";
import type { Queryable } from "../introspection/types.js";

export interface CatalogColumn {
  attnum: number;
  name: string;
  /** `format_type(atttypid, atttypmod)`: the full type, e.g. "character varying(20)". */
  dataType: string;
  /**
   * The type a value for this column is cast to: the column's type with
   * domains followed down and WITHOUT a modifier, so that the assignment to the
   * column (not the cast) enforces a length or a domain's rule, and refuses
   * instead of cutting. `format_type(oid, NULL)` prints `char(n)` as
   * "character" and `bit(n)` as "bit", which as SQL mean length 1 and would
   * cut the value, so those two are written `bpchar` and `pg_catalog.bit`.
   */
  castType: string;
  /** The type after following domains down, without a modifier (e.g. "bytea"). */
  rootType: string;
  /** Oid of `rootType`. */
  rootTypeOid: string;
  /** Oid of the column's own type (a domain stays a domain). */
  typeOid: string;
  notNull: boolean;
  hasDefault: boolean;
  identity: IdentityKind | null;
  /** A generated (computed) column. */
  generated: boolean;
  isBytea: boolean;
  isArray: boolean;
}

export interface CatalogTable {
  oid: string;
  reltype: string;
  schema: string;
  name: string;
  /** r, p, v, m or f. */
  relkind: string;
  isPartition: boolean;
  /** The planner's row estimate; -1 when never analysed (PostgreSQL 14+). */
  reltuples: number;
  columns: CatalogColumn[];
}

const TABLE_SQL = `
  SELECT c.oid::text AS oid, c.reltype::text AS reltype, c.relkind::text AS relkind,
    c.relispartition AS is_partition, c.reltuples::float8 AS reltuples
  FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = $1 AND c.relname = $2
    AND c.relkind = ANY ($3::"char"[])
    AND ${excludeSystemSchemas("n.nspname")}
`;

const COLUMNS_SQL = `
  WITH RECURSIVE cols AS (
    SELECT a.attnum, a.attname::text AS name, a.atttypid,
      pg_catalog.format_type(a.atttypid, a.atttypmod) AS data_type,
      a.attnotnull AS not_null, a.atthasdef AS has_default,
      a.attidentity::text AS identity, a.attgenerated::text AS generated
    FROM pg_catalog.pg_attribute a
    WHERE a.attrelid = $1::oid AND a.attnum > 0 AND NOT a.attisdropped
  ), base(attnum, typid) AS (
    SELECT attnum, atttypid FROM cols
    UNION ALL
    SELECT b.attnum, t.typbasetype
    FROM base b JOIN pg_catalog.pg_type t ON t.oid = b.typid
    WHERE t.typtype = 'd'
  )
  SELECT c.attnum::int AS attnum, c.name, c.data_type, c.not_null, c.has_default,
    CASE bt.oid
      WHEN 'pg_catalog.bpchar'::regtype THEN 'bpchar'
      WHEN 'pg_catalog._bpchar'::regtype THEN 'bpchar[]'
      WHEN 'pg_catalog.bit'::regtype THEN 'pg_catalog.bit'
      WHEN 'pg_catalog._bit'::regtype THEN 'pg_catalog.bit[]'
      ELSE pg_catalog.format_type(bt.oid, NULL)
    END AS cast_type,
    c.identity, c.generated, c.atttypid::text AS type_oid,
    bt.oid::text AS root_type_oid,
    pg_catalog.format_type(bt.oid, NULL) AS root_type,
    (bt.oid = 'pg_catalog.bytea'::regtype) AS is_bytea,
    (bt.typcategory = 'A') AS is_array
  FROM cols c
  JOIN base b ON b.attnum = c.attnum
  JOIN pg_catalog.pg_type bt ON bt.oid = b.typid AND bt.typtype <> 'd'
  ORDER BY c.attnum
`;

interface ColumnRow {
  attnum: number;
  name: string;
  data_type: string;
  cast_type: string;
  not_null: boolean;
  has_default: boolean;
  identity: string;
  generated: string;
  type_oid: string;
  root_type_oid: string;
  root_type: string;
  is_bytea: boolean;
  is_array: boolean;
}

/** A table, view or other listed relation with its columns, or null when there is none. */
export async function loadTable(db: Queryable, ref: TableRef): Promise<CatalogTable | null> {
  const { rows } = await db.query<{
    oid: string;
    reltype: string;
    relkind: string;
    is_partition: boolean;
    reltuples: number;
  }>(TABLE_SQL, [ref.schema, ref.name, LISTED_RELKINDS]);
  const row = rows[0];
  if (!row) return null;
  const columns = await db.query<ColumnRow>(COLUMNS_SQL, [row.oid]);
  return {
    oid: row.oid,
    reltype: row.reltype,
    schema: ref.schema,
    name: ref.name,
    relkind: row.relkind,
    isPartition: row.is_partition,
    reltuples: row.reltuples,
    columns: columns.rows.map((c) => ({
      attnum: c.attnum,
      name: c.name,
      dataType: c.data_type,
      castType: c.cast_type,
      rootType: c.root_type,
      rootTypeOid: c.root_type_oid,
      typeOid: c.type_oid,
      notNull: c.not_null,
      hasDefault: c.has_default,
      identity: c.identity === "a" ? "always" : c.identity === "d" ? "by_default" : null,
      generated: c.generated !== "",
      isBytea: c.is_bytea,
      isArray: c.is_array,
    })),
  };
}

// ---------------------------------------------------------------- triggers ---

/** Bits of `pg_trigger.tgtype` for the events a row change fires. */
export const TRIGGER_EVENT = { insert: 4, delete: 8, update: 16 } as const;

/** Enabled user triggers on the table that fire on any of `events` (a bit mask). */
export async function listTriggers(db: Queryable, oid: string, events: number): Promise<string[]> {
  const { rows } = await db.query<{ name: string }>(
    `SELECT tgname::text AS name
     FROM pg_catalog.pg_trigger
     WHERE tgrelid = $1::oid AND NOT tgisinternal AND tgenabled <> 'D' AND (tgtype & $2::int) <> 0
     ORDER BY tgname`,
    [oid, events],
  );
  return rows.map((r) => r.name);
}

// ------------------------------------------------------------ foreign keys ---

const INCOMING_FKS_SQL = `
  SELECT con.conname::text AS name, fn.nspname::text AS from_schema, fc.relname::text AS from_table,
    ARRAY(
      SELECT a.attname::text
      FROM unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord)
      JOIN pg_catalog.pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum
      ORDER BY k.ord
    ) AS from_columns,
    ARRAY(
      SELECT a.attname::text
      FROM unnest(con.confkey) WITH ORDINALITY AS k(attnum, ord)
      JOIN pg_catalog.pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.attnum
      ORDER BY k.ord
    ) AS columns,
    con.confdeltype::text AS on_delete, con.confupdtype::text AS on_update
  FROM pg_catalog.pg_constraint con
  JOIN pg_catalog.pg_class fc ON fc.oid = con.conrelid
  JOIN pg_catalog.pg_namespace fn ON fn.oid = fc.relnamespace
  WHERE con.contype = 'f' AND con.confrelid = $1::oid AND con.conparentid = 0
  ORDER BY fn.nspname, fc.relname, con.conname
`;

/** Foreign keys of any table (this one included) that point at this table. */
export async function listIncomingForeignKeys(
  db: Queryable,
  oid: string,
): Promise<IncomingForeignKey[]> {
  const { rows } = await db.query<{
    name: string;
    from_schema: string;
    from_table: string;
    from_columns: string[];
    columns: string[];
    on_delete: string;
    on_update: string;
  }>(INCOMING_FKS_SQL, [oid]);
  return rows.map((r) => ({
    name: r.name,
    from: { schema: r.from_schema, table: r.from_table, columns: r.from_columns },
    columns: r.columns,
    onDelete: referentialAction(r.on_delete),
    onUpdate: referentialAction(r.on_update),
  }));
}

// ------------------------------------------------- constraints and indexes ---

export interface CatalogConstraint {
  name: string;
  /** p, u, f, c, x. */
  type: string;
  columns: string[];
  /** The index behind a primary key or unique constraint ("0" for none). */
  indexOid: string;
}

export async function listConstraints(db: Queryable, oid: string): Promise<CatalogConstraint[]> {
  const { rows } = await db.query<{
    name: string;
    type: string;
    columns: string[];
    index_oid: string;
  }>(
    `SELECT con.conname::text AS name, con.contype::text AS type, con.conindid::text AS index_oid,
       ARRAY(
         SELECT a.attname::text
         FROM unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord)
         JOIN pg_catalog.pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum
         ORDER BY k.ord
       ) AS columns
     FROM pg_catalog.pg_constraint con
     WHERE con.conrelid = $1::oid
     ORDER BY con.conname`,
    [oid],
  );
  return rows.map((r) => ({
    name: r.name,
    type: r.type,
    columns: r.columns,
    indexOid: r.index_oid,
  }));
}

export interface CatalogIndex {
  oid: string;
  name: string;
  /** The constraint this index enforces, or null. */
  constraint: string | null;
}

export async function findIndex(
  db: Queryable,
  tableOid: string,
  name: string,
): Promise<CatalogIndex | null> {
  const { rows } = await db.query<{ oid: string; name: string; constraint: string | null }>(
    `SELECT i.oid::text AS oid, i.relname::text AS name,
       (SELECT con.conname::text FROM pg_catalog.pg_constraint con
        WHERE con.conindid = i.oid AND con.conrelid = ix.indrelid AND con.contype IN ('p', 'u', 'x')
        LIMIT 1) AS constraint
     FROM pg_catalog.pg_index ix
     JOIN pg_catalog.pg_class i ON i.oid = ix.indexrelid
     WHERE ix.indrelid = $1::oid AND i.relname = $2`,
    [tableOid, name],
  );
  return rows[0] ?? null;
}

/** Foreign keys of other tables (or this one) that rely on a unique index: they must go first. */
export async function foreignKeysUsingIndex(db: Queryable, indexOid: string): Promise<string[]> {
  const { rows } = await db.query<{ name: string }>(
    `SELECT n.nspname || '.' || c.relname || ': ' || con.conname AS name
     FROM pg_catalog.pg_constraint con
     JOIN pg_catalog.pg_class c ON c.oid = con.conrelid
     JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE con.contype = 'f' AND con.conindid = $1::oid AND con.conparentid = 0
     ORDER BY 1`,
    [indexOid],
  );
  return rows.map((r) => r.name);
}

/**
 * Is there a primary key or a valid, non-partial unique index on exactly these
 * columns (in any order)? That is what a foreign key may point at.
 */
export async function hasUniqueKeyOn(
  db: Queryable,
  tableOid: string,
  columns: readonly string[],
): Promise<boolean> {
  const { rows } = await db.query(
    `SELECT 1
     FROM pg_catalog.pg_index ix
     WHERE ix.indrelid = $1::oid AND ix.indisunique AND ix.indisvalid AND ix.indpred IS NULL
       AND ix.indexprs IS NULL AND ix.indnkeyatts = cardinality($2::text[])
       AND (
         SELECT array_agg(a.attname::text ORDER BY a.attname)
         FROM generate_series(0, ix.indnkeyatts - 1) AS g(pos)
         JOIN pg_catalog.pg_attribute a ON a.attrelid = ix.indrelid AND a.attnum = ix.indkey[g.pos]
       ) = (SELECT array_agg(x ORDER BY x) FROM unnest($2::text[]) AS x)
     LIMIT 1`,
    [tableOid, columns],
  );
  return rows.length > 0;
}

// ------------------------------------------------------------- dependents ---

/**
 * What depends on a table (attnum null) or on one of its columns, described by
 * the catalog (`view public.v`, `constraint orders_user_id_fkey on table orders`,
 * `index users_email_idx`).
 *
 * For a COLUMN: every normal and automatic dependency (views, indexes,
 * constraints, other columns of its type), except its own default and the
 * sequence a serial column owns, which go with it anyway.
 * For a TABLE: only things OUTSIDE the table (views, other tables' foreign
 * keys, inheritance children, columns or functions using its row type); its
 * own indexes, constraints and rules go with it.
 */
export async function listDependents(
  db: Queryable,
  table: Pick<CatalogTable, "oid" | "reltype">,
  attnum: number | null,
): Promise<string[]> {
  const { rows } = await db.query<{ description: string | null }>(
    `SELECT DISTINCT
       CASE
         WHEN d.classid = 'pg_catalog.pg_rewrite'::regclass THEN (
           SELECT 'view ' || vn.nspname || '.' || vc.relname
           FROM pg_catalog.pg_rewrite rw
           JOIN pg_catalog.pg_class vc ON vc.oid = rw.ev_class
           JOIN pg_catalog.pg_namespace vn ON vn.oid = vc.relnamespace
           WHERE rw.oid = d.objid
         )
         ELSE pg_catalog.pg_describe_object(d.classid, d.objid, d.objsubid)
       END AS description
     FROM pg_catalog.pg_depend d
     WHERE (
         (d.refclassid = 'pg_catalog.pg_class'::regclass AND d.refobjid = $1::oid
           AND ($2::int IS NULL OR d.refobjsubid = $2::int))
         OR ($2::int IS NULL AND d.refclassid = 'pg_catalog.pg_type'::regclass
           AND d.refobjid = $3::oid)
       )
       AND d.deptype = ANY (CASE WHEN $2::int IS NULL THEN ARRAY['n']::"char"[]
                                 ELSE ARRAY['n', 'a']::"char"[] END)
       AND d.classid <> 'pg_catalog.pg_attrdef'::regclass
       AND NOT (d.classid = 'pg_catalog.pg_class'::regclass AND EXISTS (
         SELECT 1 FROM pg_catalog.pg_class s
         WHERE s.oid = d.objid AND (s.relkind = 'S' OR s.oid = $1::oid)))
       AND NOT (d.classid = 'pg_catalog.pg_type'::regclass AND EXISTS (
         SELECT 1 FROM pg_catalog.pg_type t WHERE t.oid = d.objid AND t.typrelid = $1::oid))
       AND NOT (d.classid = 'pg_catalog.pg_rewrite'::regclass AND EXISTS (
         SELECT 1 FROM pg_catalog.pg_rewrite rw WHERE rw.oid = d.objid AND rw.ev_class = $1::oid))
       AND NOT (d.classid = 'pg_catalog.pg_constraint'::regclass AND EXISTS (
         SELECT 1 FROM pg_catalog.pg_constraint c WHERE c.oid = d.objid AND c.contype = 'n'))
       AND NOT ($2::int IS NULL AND d.classid = 'pg_catalog.pg_constraint'::regclass AND EXISTS (
         SELECT 1 FROM pg_catalog.pg_constraint c WHERE c.oid = d.objid AND c.conrelid = $1::oid))
     ORDER BY 1`,
    [table.oid, attnum, table.reltype],
  );
  return rows.flatMap((r) => (r.description ? [r.description] : []));
}

/** Views (and materialized views) that read the table, or one of its columns. */
export async function listDependentViews(
  db: Queryable,
  tableOid: string,
  attnum: number | null,
): Promise<string[]> {
  const { rows } = await db.query<{ name: string }>(
    `SELECT DISTINCT vn.nspname || '.' || vc.relname AS name
     FROM pg_catalog.pg_depend d
     JOIN pg_catalog.pg_rewrite rw ON rw.oid = d.objid
     JOIN pg_catalog.pg_class vc ON vc.oid = rw.ev_class
     JOIN pg_catalog.pg_namespace vn ON vn.oid = vc.relnamespace
     WHERE d.classid = 'pg_catalog.pg_rewrite'::regclass
       AND d.refclassid = 'pg_catalog.pg_class'::regclass
       AND d.refobjid = $1::oid
       AND ($2::int IS NULL OR d.refobjsubid = $2::int)
       AND rw.ev_class <> $1::oid
     ORDER BY 1`,
    [tableOid, attnum],
  );
  return rows.map((r) => r.name);
}

// ------------------------------------------------------------------ names ---

export async function schemaExists(db: Queryable, schema: string): Promise<boolean> {
  const { rows } = await db.query(
    `SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname = $1 AND ${excludeSystemSchemas("nspname")}`,
    [schema],
  );
  return rows.length > 0;
}

/** Is a relation of any kind (table, view, index, sequence, ...) called this in the schema? */
export async function relationNameTaken(
  db: Queryable,
  schema: string,
  name: string,
): Promise<boolean> {
  const { rows } = await db.query(
    `SELECT 1 FROM pg_catalog.pg_class c
     JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = $1 AND c.relname = $2`,
    [schema, name],
  );
  return rows.length > 0;
}

/**
 * The `gen_random_uuid()` this server has, qualified, or null. Built in from
 * PostgreSQL 13; on 12 only when an extension (pgcrypto) provides it.
 */
export async function findUuidFunction(db: Queryable): Promise<{ schema: string } | null> {
  const { rows } = await db.query<{ schema: string }>(
    `SELECT n.nspname::text AS schema
     FROM pg_catalog.pg_proc p
     JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
     WHERE p.proname = 'gen_random_uuid' AND p.pronargs = 0
     ORDER BY (n.nspname = 'pg_catalog') DESC, n.nspname
     LIMIT 1`,
  );
  return rows[0] ?? null;
}

/** The oid and category of a type written as SQL text (from the allow-list), or null. */
export async function resolveType(
  db: Queryable,
  typeSql: string,
): Promise<{ oid: string; category: string } | null> {
  const { rows } = await db.query<{ oid: string | null; category: string | null }>(
    `SELECT t.oid::text AS oid, t.typcategory::text AS category
     FROM pg_catalog.pg_type t WHERE t.oid = pg_catalog.to_regtype($1)`,
    [typeSql],
  );
  const row = rows[0];
  return row?.oid && row.category ? { oid: row.oid, category: row.category } : null;
}

/** Is there an implicit or assignment cast from one type to another (decision 132)? */
export async function hasAssignmentCast(
  db: Queryable,
  fromOid: string,
  toOid: string,
): Promise<boolean> {
  const { rows } = await db.query(
    `SELECT 1 FROM pg_catalog.pg_cast
     WHERE castsource = $1::oid AND casttarget = $2::oid AND castcontext IN ('i', 'a')`,
    [fromOid, toOid],
  );
  return rows.length > 0;
}
