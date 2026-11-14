import {
  normalizeObjects,
  type DatabaseObjects,
  type ExtensionInfo,
  type FunctionInfo,
  type ObjectRef,
  type PolicyCommand,
  type PolicyInfo,
  type RowSecurityInfo,
  type SequenceInfo,
  type TriggerEvent,
  type TriggerInfo,
  type TriggerState,
  type TriggerTiming,
  type TypeInfo,
  type TypeKind,
  type ViewInfo,
  type Volatility,
} from "@datacanvas/database-core";
import { excludeSystemSchemas } from "./system-schemas.js";
import type { Queryable } from "./types.js";

/**
 * Views, types, sequences, functions, triggers, extensions and row-level
 * security policies, read from the system catalogs. One query per kind, all
 * inside the read-only transaction the adapter already opened. Nothing here
 * reads a table's rows or a sequence's current value.
 *
 * Rules shared by the queries:
 *  - Only objects outside the system schemas (`pg_*`, `information_schema`).
 *  - Objects that belong to an EXTENSION are skipped. They are recorded in
 *    pg_depend with `deptype = 'e'` ("extension member"). Without this, installing
 *    pgcrypto or PostGIS would add hundreds of functions and types the user did
 *    not write. The extension itself is listed.
 *  - Definitions come from the server's own pretty-printers (`pg_get_viewdef`,
 *    `pg_get_functiondef`, `pg_get_triggerdef`, `pg_get_expr`), so the text is
 *    exactly what PostgreSQL would print, not something rebuilt here.
 *  - Written for PostgreSQL 12 and newer: no `tgparentid` (13+); partitions'
 *    copies of a trigger are skipped by hiding partitions, as the table list does.
 */

/**
 * SQL condition: this catalog row does not depend on another object in the way
 * `deptypes` says. pg_depend records "extension member" as 'e' and "created as
 * a part of another object" as 'i'. `catalog` is the (fixed, schema-qualified)
 * catalog table name and `oid` the SQL expression for the row's oid. Only
 * constants from this file are ever passed in.
 */
const notDependent = (catalog: string, oid: string, deptypes: string): string => `NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_depend ext
    WHERE ext.classid = '${catalog}'::regclass AND ext.objid = ${oid}
      AND ext.deptype IN (${deptypes})
  )`;

/** Not a member of an extension (its functions, types and views are not the user's own). */
const notExtensionMember = (catalog: string, oid: string): string =>
  notDependent(catalog, oid, "'e'");

// ------------------------------------------------------------------- views ---

/**
 * Relkind v = view, m = materialized view. `pg_get_viewdef(oid, true)` is the
 * query as PostgreSQL prints it ("true" = pretty-printed).
 */
const VIEWS_SQL = `
  SELECT
    n.nspname::text AS schema,
    c.relname::text AS name,
    c.relkind = 'm' AS materialized,
    d.description AS comment,
    pg_catalog.pg_get_viewdef(c.oid, true) AS definition
  FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  LEFT JOIN pg_catalog.pg_description d
    ON d.objoid = c.oid AND d.classoid = 'pg_catalog.pg_class'::regclass AND d.objsubid = 0
  WHERE c.relkind IN ('v', 'm')
    AND ${excludeSystemSchemas("n.nspname")}
    AND ${notExtensionMember("pg_catalog.pg_class", "c.oid")}
  ORDER BY n.nspname, c.relname
`;

/**
 * What a view reads. A view's query is stored as a rewrite rule (pg_rewrite,
 * `ev_class` = the view), and every table or view that rule uses is recorded
 * as a dependency of that rule in pg_depend. The view's own entry is skipped
 * (a rule depends on its own view), and so are non-relations such as functions
 * and types. DISTINCT: a dependency is recorded once per column used.
 */
const VIEW_DEPENDENCIES_SQL = `
  SELECT DISTINCT
    vn.nspname::text AS view_schema,
    v.relname::text AS view_name,
    dn.nspname::text AS dep_schema,
    d.relname::text AS dep_name
  FROM pg_catalog.pg_class v
  JOIN pg_catalog.pg_namespace vn ON vn.oid = v.relnamespace
  JOIN pg_catalog.pg_rewrite r ON r.ev_class = v.oid
  JOIN pg_catalog.pg_depend dep
    ON dep.classid = 'pg_catalog.pg_rewrite'::regclass
   AND dep.objid = r.oid
   AND dep.refclassid = 'pg_catalog.pg_class'::regclass
  JOIN pg_catalog.pg_class d ON d.oid = dep.refobjid
  JOIN pg_catalog.pg_namespace dn ON dn.oid = d.relnamespace
  WHERE v.relkind IN ('v', 'm')
    AND d.oid <> v.oid
    AND d.relkind IN ('r', 'p', 'v', 'm', 'f')
    AND ${excludeSystemSchemas("vn.nspname")}
    AND ${excludeSystemSchemas("dn.nspname")}
`;

interface ViewRow {
  schema: string;
  name: string;
  materialized: boolean;
  comment: string | null;
  definition: string | null;
}
interface DependencyRow {
  view_schema: string;
  view_name: string;
  dep_schema: string;
  dep_name: string;
}

async function listViews(db: Queryable): Promise<ViewInfo[]> {
  const views = await db.query<ViewRow>(VIEWS_SQL);
  const dependencies = await db.query<DependencyRow>(VIEW_DEPENDENCIES_SQL);
  const byView = new Map<string, ObjectRef[]>();
  for (const row of dependencies.rows) {
    const key = JSON.stringify([row.view_schema, row.view_name]);
    byView.set(key, [...(byView.get(key) ?? []), { schema: row.dep_schema, name: row.dep_name }]);
  }
  return views.rows.map((row) => ({
    schema: row.schema,
    name: row.name,
    materialized: row.materialized,
    comment: row.comment,
    definition: row.definition ?? "",
    dependsOn: byView.get(JSON.stringify([row.schema, row.name])) ?? [],
  }));
}

// ------------------------------------------------------------------- types ---

/**
 * pg_type.typtype: e = enum, d = domain, r = range, c = composite. A composite
 * type exists for EVERY table too (its row type), so composites are kept only
 * when their pg_class entry is relkind 'c' (a type made with CREATE TYPE ... AS).
 * Base, pseudo and array types are not user-defined types and are not listed.
 *
 * - Enum labels come from pg_enum in `enumsortorder`, the order they were declared.
 * - Composite attributes come from pg_attribute of the type's class (`typrelid`),
 *   skipping system and dropped columns, as JSON so the order and the pairs stay together.
 * - A domain's base type is `typbasetype` (+ `typtypmod`); a range's bound type is in pg_range.
 * - Domain checks: pg_constraint rows with `contypid` = the domain, contype 'c' only.
 *   (PostgreSQL 17 also stores NOT NULL there; `typnotnull` already says it in every version.)
 */
const TYPES_SQL = `
  SELECT
    n.nspname::text AS schema,
    t.typname::text AS name,
    t.typtype::text AS typtype,
    d.description AS comment,
    ARRAY(
      SELECT e.enumlabel::text FROM pg_catalog.pg_enum e
      WHERE e.enumtypid = t.oid ORDER BY e.enumsortorder
    ) AS "values",
    COALESCE((
      SELECT json_agg(json_build_object(
               'name', a.attname::text,
               'dataType', pg_catalog.format_type(a.atttypid, a.atttypmod)
             ) ORDER BY a.attnum)
      FROM pg_catalog.pg_attribute a
      WHERE t.typtype = 'c' AND a.attrelid = t.typrelid AND a.attnum > 0 AND NOT a.attisdropped
    ), '[]'::json) AS attributes,
    CASE t.typtype
      WHEN 'd' THEN pg_catalog.format_type(t.typbasetype, t.typtypmod)
      WHEN 'r' THEN (SELECT pg_catalog.format_type(r.rngsubtype, NULL)
                     FROM pg_catalog.pg_range r WHERE r.rngtypid = t.oid)
    END AS base_type,
    CASE WHEN t.typtype = 'd' THEN t.typdefault END AS default_value,
    CASE WHEN t.typtype = 'd' AND t.typnotnull THEN true ELSE false END AS not_null,
    CASE WHEN t.typtype = 'd' THEN ARRAY(
      SELECT pg_catalog.pg_get_constraintdef(c.oid, true)
      FROM pg_catalog.pg_constraint c
      WHERE c.contypid = t.oid AND c.contype = 'c' ORDER BY c.conname
    ) ELSE ARRAY[]::text[] END AS checks
  FROM pg_catalog.pg_type t
  JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
  LEFT JOIN pg_catalog.pg_description d
    ON d.objoid = t.oid AND d.classoid = 'pg_catalog.pg_type'::regclass AND d.objsubid = 0
  WHERE (t.typtype IN ('e', 'd', 'r')
         OR (t.typtype = 'c' AND EXISTS (
               SELECT 1 FROM pg_catalog.pg_class k WHERE k.oid = t.typrelid AND k.relkind = 'c')))
    AND ${excludeSystemSchemas("n.nspname")}
    AND ${notExtensionMember("pg_catalog.pg_type", "t.oid")}
  ORDER BY n.nspname, t.typname
`;

interface TypeRow {
  schema: string;
  name: string;
  typtype: string;
  comment: string | null;
  values: string[];
  attributes: Array<{ name: string; dataType: string }>;
  base_type: string | null;
  default_value: string | null;
  not_null: boolean;
  checks: string[];
}

const TYPE_KINDS: Record<string, TypeKind> = {
  e: "enum",
  c: "composite",
  d: "domain",
  r: "range",
};

async function listTypes(db: Queryable): Promise<TypeInfo[]> {
  const { rows } = await db.query<TypeRow>(TYPES_SQL);
  return rows.flatMap((row): TypeInfo[] => {
    const kind = TYPE_KINDS[row.typtype];
    if (kind === undefined) return [];
    return [
      {
        schema: row.schema,
        name: row.name,
        kind,
        comment: row.comment,
        values: row.values,
        attributes: row.attributes,
        baseType: row.base_type,
        defaultValue: row.default_value,
        constraints: [...(row.not_null ? ["NOT NULL"] : []), ...row.checks],
      },
    ];
  });
}

// --------------------------------------------------------------- sequences ---

/**
 * pg_sequence holds a sequence's settings (PostgreSQL 10+). The numbers are
 * cast to text because a bigint sequence's limits do not fit a JavaScript
 * number exactly. The CURRENT value is deliberately not read: it is data that
 * changes with every insert (and `pg_sequence_last_value` would be a read of it).
 *
 * "Owned by": a serial or identity column records its sequence in pg_depend as
 * an automatic ('a') or internal ('i') dependency of the sequence on that
 * table column (`refobjsubid` > 0 is the column number).
 */
const SEQUENCES_SQL = `
  SELECT
    n.nspname::text AS schema,
    c.relname::text AS name,
    pg_catalog.format_type(s.seqtypid, NULL) AS data_type,
    s.seqstart::text AS start,
    s.seqincrement::text AS increment,
    s.seqmin::text AS min,
    s.seqmax::text AS max,
    s.seqcache::text AS cache,
    s.seqcycle AS cycle,
    own.owner_schema,
    own.owner_table,
    own.owner_column
  FROM pg_catalog.pg_sequence s
  JOIN pg_catalog.pg_class c ON c.oid = s.seqrelid
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  LEFT JOIN LATERAL (
    SELECT tn.nspname::text AS owner_schema, tc.relname::text AS owner_table, a.attname::text AS owner_column
    FROM pg_catalog.pg_depend dep
    JOIN pg_catalog.pg_class tc ON tc.oid = dep.refobjid
    JOIN pg_catalog.pg_namespace tn ON tn.oid = tc.relnamespace
    JOIN pg_catalog.pg_attribute a ON a.attrelid = dep.refobjid AND a.attnum = dep.refobjsubid
    WHERE dep.classid = 'pg_catalog.pg_class'::regclass
      AND dep.objid = c.oid
      AND dep.refclassid = 'pg_catalog.pg_class'::regclass
      AND dep.refobjsubid > 0
      AND dep.deptype IN ('a', 'i')
    ORDER BY tn.nspname, tc.relname, a.attname
    LIMIT 1
  ) own ON true
  WHERE ${excludeSystemSchemas("n.nspname")}
    AND ${notExtensionMember("pg_catalog.pg_class", "c.oid")}
  ORDER BY n.nspname, c.relname
`;

interface SequenceRow {
  schema: string;
  name: string;
  data_type: string;
  start: string;
  increment: string;
  min: string;
  max: string;
  cache: string;
  cycle: boolean;
  owner_schema: string | null;
  owner_table: string | null;
  owner_column: string | null;
}

async function listSequences(db: Queryable): Promise<SequenceInfo[]> {
  const { rows } = await db.query<SequenceRow>(SEQUENCES_SQL);
  return rows.map((row) => ({
    schema: row.schema,
    name: row.name,
    dataType: row.data_type,
    start: row.start,
    increment: row.increment,
    min: row.min,
    max: row.max,
    cache: row.cache,
    cycle: row.cycle,
    ownedBy:
      row.owner_schema !== null && row.owner_table !== null && row.owner_column !== null
        ? { schema: row.owner_schema, table: row.owner_table, column: row.owner_column }
        : null,
  }));
}

// --------------------------------------------------------------- functions ---

/**
 * prokind: f = function, p = procedure (a = aggregate and w = window function
 * are not listed: they have no body of their own to show). The identity
 * argument list is what tells overloads apart (`pg_get_function_identity_arguments`);
 * `pg_get_functiondef` is the full CREATE statement including the body.
 * provolatile: i = immutable, s = stable, v = volatile.
 *
 * Functions the server made as part of something else are skipped as well as
 * extension members (dependency 'i'): creating a range type also creates its
 * constructor functions, which the user never wrote.
 */
const FUNCTIONS_SQL = `
  SELECT
    n.nspname::text AS schema,
    p.proname::text AS name,
    p.prokind::text AS prokind,
    pg_catalog.pg_get_function_identity_arguments(p.oid) AS arguments,
    CASE WHEN p.prokind = 'p' THEN NULL ELSE pg_catalog.pg_get_function_result(p.oid) END AS returns,
    l.lanname::text AS language,
    p.provolatile::text AS volatility,
    p.prosecdef AS security_definer,
    d.description AS comment,
    pg_catalog.pg_get_functiondef(p.oid) AS definition
  FROM pg_catalog.pg_proc p
  JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
  JOIN pg_catalog.pg_language l ON l.oid = p.prolang
  LEFT JOIN pg_catalog.pg_description d
    ON d.objoid = p.oid AND d.classoid = 'pg_catalog.pg_proc'::regclass AND d.objsubid = 0
  WHERE p.prokind IN ('f', 'p')
    AND ${excludeSystemSchemas("n.nspname")}
    AND ${notDependent("pg_catalog.pg_proc", "p.oid", "'e', 'i'")}
  ORDER BY n.nspname, p.proname, 4
`;

interface FunctionRow {
  schema: string;
  name: string;
  prokind: string;
  arguments: string;
  returns: string | null;
  language: string;
  volatility: string;
  security_definer: boolean;
  comment: string | null;
  definition: string | null;
}

/**
 * `pg_get_function_identity_arguments` prints a procedure's arguments with an
 * explicit `IN` from PostgreSQL 14 on ("IN x integer") and without it before
 * ("x integer"). The argument list is what identifies a function, so it is
 * written without the redundant `IN`, and a snapshot from one version compares
 * cleanly with a database on another. (`IN` is the default mode; a bare `IN`
 * cannot be a name, because it is a reserved word and would be quoted.)
 */
export function normalizeArguments(args: string): string {
  return args.replace(/(^|, )IN (?=\S)/g, "$1");
}

const VOLATILITY: Record<string, Volatility> = { i: "immutable", s: "stable", v: "volatile" };

async function listFunctions(db: Queryable): Promise<FunctionInfo[]> {
  const { rows } = await db.query<FunctionRow>(FUNCTIONS_SQL);
  return rows.map((row) => ({
    schema: row.schema,
    name: row.name,
    kind: row.prokind === "p" ? "procedure" : "function",
    arguments: normalizeArguments(row.arguments),
    returns: row.returns,
    language: row.language,
    volatility: VOLATILITY[row.volatility] ?? "volatile",
    securityDefiner: row.security_definer,
    comment: row.comment,
    definition: row.definition ?? "",
  }));
}

// --------------------------------------------------------------- triggers ---

/**
 * User triggers only (`NOT tgisinternal` hides the triggers PostgreSQL creates
 * to enforce foreign keys). `tgtype` packs the timing, events and level into
 * bits (see `decodeTriggerType`). `tgenabled`: O = enabled (origin), D = disabled,
 * R = replica only, A = always.
 */
const TRIGGERS_SQL = `
  SELECT
    n.nspname::text AS schema,
    c.relname::text AS "table",
    t.tgname::text AS name,
    t.tgtype::int AS tgtype,
    t.tgenabled::text AS enabled,
    pn.nspname::text AS function_schema,
    p.proname::text AS function_name,
    pg_catalog.pg_get_triggerdef(t.oid, true) AS definition
  FROM pg_catalog.pg_trigger t
  JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_catalog.pg_proc p ON p.oid = t.tgfoid
  JOIN pg_catalog.pg_namespace pn ON pn.oid = p.pronamespace
  WHERE NOT t.tgisinternal
    AND NOT c.relispartition
    AND ${excludeSystemSchemas("n.nspname")}
  ORDER BY n.nspname, c.relname, t.tgname
`;

interface TriggerRow {
  schema: string;
  table: string;
  name: string;
  tgtype: number;
  enabled: string;
  function_schema: string;
  function_name: string;
  definition: string | null;
}

/** Bits of `pg_trigger.tgtype`. */
const TG_ROW = 1;
const TG_BEFORE = 2;
const TG_INSERT = 4;
const TG_DELETE = 8;
const TG_UPDATE = 16;
const TG_TRUNCATE = 32;
const TG_INSTEAD = 64;

export function decodeTriggerType(tgtype: number): {
  timing: TriggerTiming;
  events: TriggerEvent[];
  level: "row" | "statement";
} {
  const events: TriggerEvent[] = [];
  if (tgtype & TG_INSERT) events.push("insert");
  if (tgtype & TG_UPDATE) events.push("update");
  if (tgtype & TG_DELETE) events.push("delete");
  if (tgtype & TG_TRUNCATE) events.push("truncate");
  return {
    timing: tgtype & TG_INSTEAD ? "instead_of" : tgtype & TG_BEFORE ? "before" : "after",
    events,
    level: tgtype & TG_ROW ? "row" : "statement",
  };
}

const TRIGGER_STATE: Record<string, TriggerState> = {
  O: "enabled",
  D: "disabled",
  R: "replica",
  A: "always",
};

async function listTriggers(db: Queryable): Promise<TriggerInfo[]> {
  const { rows } = await db.query<TriggerRow>(TRIGGERS_SQL);
  return rows.map((row) => ({
    schema: row.schema,
    table: row.table,
    name: row.name,
    ...decodeTriggerType(row.tgtype),
    function: `${row.function_schema}.${row.function_name}`,
    state: TRIGGER_STATE[row.enabled] ?? "enabled",
    definition: row.definition ?? "",
  }));
}

// -------------------------------------------------------------- extensions ---

/** pg_extension lists installed extensions; they are per database, whatever schema their objects live in. */
const EXTENSIONS_SQL = `
  SELECT
    e.extname::text AS name,
    e.extversion::text AS version,
    n.nspname::text AS schema,
    d.description AS comment
  FROM pg_catalog.pg_extension e
  JOIN pg_catalog.pg_namespace n ON n.oid = e.extnamespace
  LEFT JOIN pg_catalog.pg_description d
    ON d.objoid = e.oid AND d.classoid = 'pg_catalog.pg_extension'::regclass AND d.objsubid = 0
  ORDER BY e.extname
`;

async function listExtensions(db: Queryable): Promise<ExtensionInfo[]> {
  const { rows } = await db.query<ExtensionInfo>(EXTENSIONS_SQL);
  return rows.map((row) => ({
    name: row.name,
    version: row.version,
    schema: row.schema,
    comment: row.comment,
  }));
}

// ---------------------------------------------------------------- policies ---

/**
 * Row-level security policies (pg_policy). `polcmd`: * = all, r = select,
 * a = insert, w = update, d = delete. `polroles` lists role oids, where 0
 * stands for PUBLIC; they are turned into names. The expressions are stored as
 * parsed trees and `pg_get_expr` prints them back as SQL text; nothing is evaluated.
 */
const POLICIES_SQL = `
  SELECT
    n.nspname::text AS schema,
    c.relname::text AS "table",
    pol.polname::text AS name,
    pol.polcmd::text AS command,
    pol.polpermissive AS permissive,
    ARRAY(
      SELECT CASE WHEN u.role_oid = 0::oid THEN 'public'
                  ELSE COALESCE(r.rolname::text, u.role_oid::text) END
      FROM unnest(pol.polroles) AS u(role_oid)
      LEFT JOIN pg_catalog.pg_roles r ON r.oid = u.role_oid
    ) AS roles,
    pg_catalog.pg_get_expr(pol.polqual, pol.polrelid) AS using_expression,
    pg_catalog.pg_get_expr(pol.polwithcheck, pol.polrelid) AS check_expression
  FROM pg_catalog.pg_policy pol
  JOIN pg_catalog.pg_class c ON c.oid = pol.polrelid
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE ${excludeSystemSchemas("n.nspname")}
  ORDER BY n.nspname, c.relname, pol.polname
`;

/** Tables with row-level security switched on, and whether it is FORCEd on the owner. */
const ROW_SECURITY_SQL = `
  SELECT n.nspname::text AS schema, c.relname::text AS "table", c.relforcerowsecurity AS forced
  FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relrowsecurity
    AND c.relkind IN ('r', 'p')
    AND NOT c.relispartition
    AND ${excludeSystemSchemas("n.nspname")}
  ORDER BY n.nspname, c.relname
`;

interface PolicyRow {
  schema: string;
  table: string;
  name: string;
  command: string;
  permissive: boolean;
  roles: string[];
  using_expression: string | null;
  check_expression: string | null;
}

const POLICY_COMMAND: Record<string, PolicyCommand> = {
  "*": "all",
  r: "select",
  a: "insert",
  w: "update",
  d: "delete",
};

async function listPolicies(db: Queryable): Promise<PolicyInfo[]> {
  const { rows } = await db.query<PolicyRow>(POLICIES_SQL);
  return rows.map((row) => ({
    schema: row.schema,
    table: row.table,
    name: row.name,
    command: POLICY_COMMAND[row.command] ?? "all",
    permissive: row.permissive,
    roles: row.roles,
    using: row.using_expression,
    withCheck: row.check_expression,
  }));
}

async function listRowSecurity(db: Queryable): Promise<RowSecurityInfo[]> {
  const { rows } = await db.query<RowSecurityInfo>(ROW_SECURITY_SQL);
  return rows.map((row) => ({ schema: row.schema, table: row.table, forced: row.forced }));
}

// ------------------------------------------------------------------- all ---

/** Every kind, one after the other on the one connection (a client runs one query at a time anyway). */
export async function listObjects(db: Queryable): Promise<DatabaseObjects> {
  const views = await listViews(db);
  const types = await listTypes(db);
  const sequences = await listSequences(db);
  const functions = await listFunctions(db);
  const triggers = await listTriggers(db);
  const extensions = await listExtensions(db);
  const policies = await listPolicies(db);
  const rowSecurity = await listRowSecurity(db);
  return normalizeObjects({
    views,
    types,
    sequences,
    functions,
    triggers,
    extensions,
    policies,
    rowSecurity,
  });
}
