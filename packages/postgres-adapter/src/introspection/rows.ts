import {
  CELL_EDIT_MAX_CHARS,
  DatabaseError,
  ROWS_CELL_CHARS,
  ROWS_MAX_COLUMNS,
  ROWS_MAX_OFFSET,
  ROWS_MAX_SORT_VALUE_CHARS,
  buildRowPage,
  checkRowsFilters,
  checkRowsSort,
  isSensitiveColumnName,
  normalizeRowsOptions,
  quoteIdentifier,
  quoteQualified,
  type CellRead,
  type CellRequest,
  type RawRow,
  type RowColumn,
  type RowColumnKind,
  type RowFilter,
  type RowFilterOp,
  type RowOrder,
  type RowPage,
  type RowSecurityState,
  type RowSort,
  type RowSortDirection,
  type RowsOptions,
  type TableRef,
} from "@datacanvas/database-core";
import { listColumns } from "./columns.js";
import { listTablesByRef } from "./tables.js";
import type { Queryable } from "./types.js";

/**
 * Reading the ROWS of one table: the only place in this adapter that reads table
 * data. Everything about it is bounded and fixed in shape:
 *
 *  - the statement is ONE shape of SELECT, built by `buildRowsQuery` from names
 *    that were first read from the catalog and are quoted; no text from the
 *    caller ever becomes part of it (the page size and the paging position are
 *    bound parameters);
 *  - every value is converted to text and cut INSIDE the database
 *    (`left(CAST(col AS text), n)`), so a huge value never travels;
 *  - it runs in the read-only transaction the adapter opens for every call.
 *
 * Rows are never logged, stored or put in an error message here.
 */

// ------------------------------------------------------------ choosing a key ---

/**
 * The columns a table can be ordered and paged by: its primary key, else a
 * unique index that is safe to order by. Safe means: valid and live, over plain
 * columns (no expression), not partial, and every key column NOT NULL (a NULL
 * would break "greater than the last key"). Only the index's KEY columns count,
 * not its INCLUDE columns. Among several, the primary key wins, then the
 * narrowest, then the oldest.
 */
const ROW_KEY_SQL = `
  SELECT
    ix.indisprimary AS "primary",
    ARRAY(
      SELECT a.attname::text
      FROM generate_series(0, ix.indnkeyatts - 1) AS g(pos)
      JOIN pg_catalog.pg_attribute a ON a.attrelid = ix.indrelid AND a.attnum = ix.indkey[g.pos]
      ORDER BY g.pos
    ) AS columns
  FROM pg_catalog.pg_index ix
  JOIN pg_catalog.pg_class t ON t.oid = ix.indrelid
  JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
  WHERE n.nspname = $1
    AND t.relname = $2
    AND ix.indisunique
    AND ix.indisvalid
    AND ix.indislive
    AND ix.indpred IS NULL
    AND ix.indexprs IS NULL
    AND NOT EXISTS (
      SELECT 1
      FROM generate_series(0, ix.indnkeyatts - 1) AS g(pos)
      JOIN pg_catalog.pg_attribute a ON a.attrelid = ix.indrelid AND a.attnum = ix.indkey[g.pos]
      WHERE NOT a.attnotnull
    )
  ORDER BY ix.indisprimary DESC, ix.indnkeyatts ASC, ix.indexrelid ASC
  LIMIT 1
`;

interface KeyRow {
  primary: boolean;
  columns: string[];
}

export async function findRowKey(db: Queryable, ref: TableRef): Promise<RowOrder> {
  const { rows } = await db.query<KeyRow>(ROW_KEY_SQL, [ref.schema, ref.name]);
  const row = rows[0];
  return row && row.columns.length > 0
    ? { kind: row.primary ? "primary_key" : "unique_index", columns: row.columns }
    : { kind: "none", columns: [] };
}

// ------------------------------------------------------------ column kinds ---

/**
 * What can be done with each column's values (see `RowColumnKind`), from the
 * catalog. A domain is followed down to its base type. "text" is the string
 * category; "ordered" is a type with a default btree operator class (enums and
 * ranges have one through a pseudo-type, so they are named), except `jsonb` and
 * `bytea`, whose order means nothing to a person. `json` and `jsonb` are "json" and arrays are
 * "array": they can be searched but not sorted. Composites have a btree class too, but over
 * `anyrecord`, which this test does not match, so they stay "other", with everything else.
 */
const COLUMN_KINDS_SQL = `
  WITH RECURSIVE cols AS (
    SELECT a.attnum, a.attname::text AS name, a.atttypid AS typid
    FROM pg_catalog.pg_attribute a
    JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped
  ), base(attnum, name, typid) AS (
    SELECT attnum, name, typid FROM cols
    UNION ALL
    SELECT b.attnum, b.name, t.typbasetype
    FROM base b JOIN pg_catalog.pg_type t ON t.oid = b.typid
    WHERE t.typtype = 'd'
  )
  SELECT
    b.name,
    CASE
      WHEN t.typcategory = 'S' THEN 'text'
      WHEN t.oid = 'pg_catalog.bytea'::regtype THEN 'other'
      WHEN t.oid IN ('pg_catalog.json'::regtype, 'pg_catalog.jsonb'::regtype) THEN 'json'
      WHEN t.typcategory = 'A' THEN 'array'
      WHEN t.typtype IN ('e', 'r', 'm') THEN 'ordered'
      WHEN EXISTS (
        SELECT 1
        FROM pg_catalog.pg_opclass oc
        JOIN pg_catalog.pg_am am ON am.oid = oc.opcmethod
        WHERE am.amname = 'btree' AND oc.opcdefault AND oc.opcintype = t.oid
      ) THEN 'ordered'
      ELSE 'other'
    END AS kind
  FROM base b
  JOIN pg_catalog.pg_type t ON t.oid = b.typid
  WHERE t.typtype <> 'd'
`;

export async function findColumnKinds(
  db: Queryable,
  ref: TableRef,
): Promise<Map<string, RowColumnKind>> {
  const { rows } = await db.query<{ name: string; kind: RowColumnKind }>(COLUMN_KINDS_SQL, [
    ref.schema,
    ref.name,
  ]);
  return new Map(rows.map((r) => [r.name, r.kind]));
}

// ------------------------------------------------------------ row security ---

/**
 * Is row-level security on for the table, and is the connected role subject to it?
 * A superuser or a role with BYPASSRLS never is; the table's owner is not either,
 * unless the table FORCEs it. Only catalog flags are read, never a policy or a row.
 */
const ROW_SECURITY_SQL = `
  SELECT
    c.relrowsecurity AS enabled,
    c.relforcerowsecurity AS forced,
    (r.rolsuper OR r.rolbypassrls) AS bypass,
    pg_catalog.pg_has_role(current_user, c.relowner, 'USAGE') AS owner
  FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_catalog.pg_roles r ON r.rolname = current_user
  WHERE n.nspname = $1 AND c.relname = $2
`;

interface RowSecurityRow {
  enabled: boolean;
  forced: boolean;
  bypass: boolean;
  owner: boolean;
}

export async function findRowSecurity(db: Queryable, ref: TableRef): Promise<RowSecurityState> {
  const { rows } = await db.query<RowSecurityRow>(ROW_SECURITY_SQL, [ref.schema, ref.name]);
  const row = rows[0];
  if (!row || !row.enabled) return "off";
  if (row.bypass || (row.owner && !row.forced)) return "exempt";
  return "applies";
}

// ------------------------------------------------------------ the statement ---

export interface RowsQueryPlan {
  schema: string;
  table: string;
  /** The columns to read, with their position in the page's column list (the alias is `c<position>`). Masked columns are not here. */
  shown: ReadonlyArray<{ position: number; name: string }>;
  /** The ordering key; empty for a table without one. */
  keyColumns: readonly string[];
  /** The key of the last row of the previous page, or null for the first page (keyed tables). */
  after: readonly string[] | null;
  /** Sort by one column (keyed tables only); the key then breaks ties. Null for the key order. */
  sort?: { column: string; direction: RowSortDirection } | null;
  /** The sort column's value in the last row of the previous page (null value: SQL NULL); present exactly when `sort` and `after` are. */
  afterSort?: { value: string | null } | null;
  /** Conditions on columns, all required (AND). Already checked against the columns that were read. */
  filters?: readonly FilterInput[];
  /** The type of each column read, as `format_type` prints it (for the conditions that need it). */
  columnTypes?: ReadonlyMap<string, string>;
  /** Where to start (tables without a key). */
  offset: number;
  /** How many rows to fetch: the page size plus one, to learn whether there is more. */
  limit: number;
  /** The characters of a cell kept (a page keeps `ROWS_CELL_CHARS`; an export keeps more). */
  cellChars?: number;
  /** Only the rows with one of these keys: each is the values of `keyColumns`, in that order (an export of chosen rows). */
  keys?: ReadonlyArray<readonly string[]>;
}

/**
 * The one statement. For a table with a key:
 *
 *   SELECT 1 AS r, left(CAST("a" AS text), $1) AS c0, CAST("k" AS text) AS k0
 *   FROM "s"."t" WHERE ROW("k") > ROW($2) ORDER BY "k" LIMIT $3
 *
 * and without one (no WHERE, no ORDER BY, so no order is promised):
 *
 *   SELECT 1 AS r, left(CAST("a" AS text), $1) AS c0 FROM "s"."t" LIMIT $2 OFFSET $3
 *
 * `$1` (when any column is read) is the cell limit plus one character, which tells
 * a value that fits from one that was cut. The key columns are selected a second time WITHOUT cutting
 * (`k0`...): the paging position must be the real key, not a shortened copy of
 * it. `1 AS r` keeps the select list from being empty when every column is masked.
 */
/** What a condition needs to know about its column, from the catalog (never from the request). */
interface ConditionColumn {
  /** The type as `format_type` prints it, valid SQL: used to cast a list into an array of the column's own type. */
  dataType: string;
}

/**
 * One condition. The operator text comes from this table, chosen by the operator's name; the column is a
 * quoted catalog name; every value is a bound parameter. `contains` and `starts with` avoid LIKE so that
 * `%`, `_` and `\` in the value are ordinary characters and need no escaping. A value that is used twice is
 * cast to text, so that PostgreSQL never has to guess which function `length($1)` means.
 */
const TEXT_OF = (c: string): string => `CAST(${c} AS text)`;

const ONE_SQL: Partial<Record<RowFilterOp, (column: string, p: string) => string>> = {
  eq: (c, p) => `${c} = ${p}`,
  neq: (c, p) => `${c} IS DISTINCT FROM ${p}`,
  gt: (c, p) => `${c} > ${p}`,
  gte: (c, p) => `${c} >= ${p}`,
  lt: (c, p) => `${c} < ${p}`,
  lte: (c, p) => `${c} <= ${p}`,
  contains: (c, p) => `strpos(lower(${TEXT_OF(c)}), lower(${p})) > 0`,
  starts_with: (c, p) => `starts_with(lower(${TEXT_OF(c)}), lower(${p}))`,
  ends_with: (c, p) =>
    `right(lower(${TEXT_OF(c)}), length(CAST(${p} AS text))) = lower(CAST(${p} AS text))`,
  not_contains: (c, p) =>
    `COALESCE(strpos(lower(${TEXT_OF(c)}), lower(CAST(${p} AS text))), 0) = 0`,
  matches: (c, p) => `${TEXT_OF(c)} ~* CAST(${p} AS text)`,
  has_key: (c, p) => `CAST(${c} AS jsonb) ? CAST(${p} AS text)`,
  json_contains: (c, p) => `CAST(${c} AS jsonb) @> CAST(${p} AS jsonb)`,
};

const NONE_SQL: Partial<Record<RowFilterOp, (column: string) => string>> = {
  is_null: (c) => `${c} IS NULL`,
  is_not_null: (c) => `${c} IS NOT NULL`,
  is_empty: (c) => `(${c} IS NOT NULL AND ${TEXT_OF(c)} = '')`,
  array_is_empty: (c) => `(${c} IS NOT NULL AND cardinality(${c}) = 0)`,
};

/** The date shortcuts, written for the column's own type so that no time zone is guessed. */
function shortcutSql(op: RowFilterOp, c: string, dataType: string): string {
  if (/^date\b/.test(dataType)) {
    const today = "CURRENT_DATE";
    const month = `CAST(date_trunc('month', ${today}) AS date)`;
    switch (op) {
      case "today":
        return `${c} = ${today}`;
      case "last_7_days":
        return `(${c} >= ${today} - 6 AND ${c} <= ${today})`;
      case "last_30_days":
        return `(${c} >= ${today} - 29 AND ${c} <= ${today})`;
      default:
        return `(${c} >= ${month} AND ${c} < CAST(${month} + interval '1 month' AS date))`;
    }
  }
  const now =
    /with time zone/.test(dataType) && !/without time zone/.test(dataType)
      ? "now()"
      : "localtimestamp";
  const day = `date_trunc('day', ${now})`;
  const month = `date_trunc('month', ${now})`;
  switch (op) {
    case "today":
      return `(${c} >= ${day} AND ${c} < ${day} + interval '1 day')`;
    case "last_7_days":
      return `(${c} >= ${day} - interval '6 days' AND ${c} < ${day} + interval '1 day')`;
    case "last_30_days":
      return `(${c} >= ${day} - interval '29 days' AND ${c} < ${day} + interval '1 day')`;
    default:
      return `(${c} >= ${month} AND ${c} < ${month} + interval '1 month')`;
  }
}

type FilterInput = {
  column: string;
  op: RowFilterOp;
  value?: string | undefined;
  values?: readonly string[] | undefined;
  path?: readonly string[] | undefined;
  group?: number | undefined;
};

function filterCondition(
  filter: FilterInput,
  param: (value: unknown) => string,
  column: ConditionColumn | undefined,
): string {
  const op = filter.op;
  const c = quoteIdentifier(filter.column);
  const bad = () => new DatabaseError("invalid_request");
  // Own keys only: a plain object also answers to "toString", "constructor" and "__proto__".
  if (Object.hasOwn(NONE_SQL, op)) {
    if (filter.value !== undefined || filter.values !== undefined) throw bad();
    return NONE_SQL[op]!(c);
  }
  if (op === "today" || op === "last_7_days" || op === "last_30_days" || op === "this_month") {
    if (!column) throw bad();
    return shortcutSql(op, c, column.dataType);
  }
  if (Object.hasOwn(ONE_SQL, op)) {
    if (typeof filter.value !== "string") throw bad();
    return ONE_SQL[op]!(c, param(filter.value));
  }
  const values = filter.values;
  switch (op) {
    case "in":
      if (!values || values.length === 0) throw bad();
      return `${c} IN (${values.map((v) => param(v)).join(", ")})`;
    case "not_in":
      if (!values || values.length === 0) throw bad();
      return `(${values.map((v) => `${c} IS DISTINCT FROM ${param(v)}`).join(" AND ")})`;
    case "between":
      if (!values || values.length !== 2) throw bad();
      return `${c} BETWEEN ${param(values[0])} AND ${param(values[1])}`;
    case "array_contains":
    case "array_overlaps": {
      if (!values || values.length === 0 || !column) throw bad();
      const list = values.map((v) => `CAST(${param(v)} AS text)`).join(", ");
      return `${c} ${op === "array_contains" ? "@>" : "&&"} CAST(ARRAY[${list}] AS ${column.dataType})`;
    }
    case "json_path_eq":
      if (!filter.path || filter.path.length === 0 || typeof filter.value !== "string") throw bad();
      return `(CAST(${c} AS jsonb) #>> CAST(${param([...filter.path])} AS text[])) = CAST(${param(filter.value)} AS text)`;
    default:
      throw bad();
  }
}

/** The person's conditions as one expression list: each ungrouped one alone, each group as `(a OR b)`. */
function filterConditions(
  filters: readonly FilterInput[],
  param: (value: unknown) => string,
  columnOf: (name: string) => ConditionColumn | undefined,
): string[] {
  const alone: string[] = [];
  const groups = new Map<number, string[]>();
  for (const filter of filters) {
    const sql = filterCondition(filter, param, columnOf(filter.column));
    if (filter.group === undefined) {
      alone.push(sql);
    } else {
      groups.set(filter.group, [...(groups.get(filter.group) ?? []), `(${sql})`]);
    }
  }
  return [...alone, ...[...groups.values()].map((list) => `(${list.join(" OR ")})`)];
}

export function buildRowsQuery(plan: RowsQueryPlan): { text: string; values: unknown[] } {
  const values: unknown[] = [];
  /** Bind a value and return its placeholder. */
  const param = (value: unknown): string => {
    values.push(value);
    return `$${values.length}`;
  };
  const select: string[] = ["1 AS r"];
  // The cell limit is a parameter only when some column uses it: PostgreSQL refuses a
  // statement with a parameter that is never referenced (42P18), which is what a table
  // whose every column is masked would otherwise be.
  const cut = plan.shown.length > 0 ? param((plan.cellChars ?? ROWS_CELL_CHARS) + 1) : null;
  for (const column of plan.shown) {
    select.push(
      `left(CAST(${quoteIdentifier(column.name)} AS text), ${cut}) AS c${column.position}`,
    );
  }
  plan.keyColumns.forEach((name, i) => {
    select.push(`CAST(${quoteIdentifier(name)} AS text) AS k${i}`);
  });
  const keyed = plan.keyColumns.length > 0;
  const sort = keyed ? (plan.sort ?? null) : null;
  const sortName = sort ? quoteIdentifier(sort.column) : "";
  // The sort value is read one character past what a cursor can carry, to tell a value that fits from one that does not.
  if (sort) {
    select.push(`left(CAST(${sortName} AS text), ${param(ROWS_MAX_SORT_VALUE_CHARS + 1)}) AS s0`);
  }

  const parts = [`SELECT ${select.join(", ")}`, `FROM ${quoteQualified(plan.schema, plan.table)}`];
  const keyList = plan.keyColumns.map(quoteIdentifier).join(", ");
  // In ORDER BY a bare name means an output column first: a table column called `c0`, `k0`, `r` or `s0` would be
  // read as the alias of the select list. Qualified by the table, it is always the table's column.
  const inTable = (column: string): string =>
    `${quoteQualified(plan.schema, plan.table)}.${column}`;
  // Each name is quoted on its own: a name with a comma in it is not split.
  const keyOrder = plan.keyColumns.map((c) => inTable(quoteIdentifier(c))).join(", ");
  // Every condition is required: the person's conditions first, then "after the last row" of the paging.
  const conditions: string[] = [];
  conditions.push(
    ...filterConditions(plan.filters ?? [], param, (name) => {
      const dataType = plan.columnTypes?.get(name);
      return dataType === undefined ? undefined : { dataType };
    }),
  );
  if (keyed && plan.keys && plan.keys.length > 0) {
    // `ROW(k1, k2) IN (ROW($1, $2), ...)`: the names are the table's key columns, every value is bound.
    const rows = plan.keys.map((key) => `ROW(${key.map((value) => param(value)).join(", ")})`);
    conditions.push(`ROW(${keyList}) IN (${rows.join(", ")})`);
  }
  if (keyed && plan.after) {
    const marks = plan.after.map((value) => param(value));
    const afterKey = `ROW(${keyList}) > ROW(${marks.join(", ")})`;
    if (!sort || !plan.afterSort) {
      conditions.push(afterKey);
    } else if (plan.afterSort.value === null) {
      // The last row had NULL in the sort column. NULL comes last when ascending and first when descending.
      conditions.push(
        sort.direction === "asc"
          ? `(${sortName} IS NULL AND ${afterKey})`
          : `((${sortName} IS NULL AND ${afterKey}) OR ${sortName} IS NOT NULL)`,
      );
    } else {
      const last = param(plan.afterSort.value);
      conditions.push(
        sort.direction === "asc"
          ? `(${sortName} > ${last} OR (${sortName} = ${last} AND ${afterKey}) OR ${sortName} IS NULL)`
          : `(${sortName} < ${last} OR (${sortName} = ${last} AND ${afterKey}))`,
      );
    }
  }
  if (conditions.length > 0) parts.push(`WHERE ${conditions.join(" AND ")}`);
  if (keyed) {
    parts.push(
      sort
        ? `ORDER BY ${inTable(sortName)} ${sort.direction === "asc" ? "ASC NULLS LAST" : "DESC NULLS FIRST"}, ${keyOrder}`
        : `ORDER BY ${keyOrder}`,
    );
  }
  parts.push(`LIMIT ${param(plan.limit)}`);
  if (!keyed) parts.push(`OFFSET ${param(plan.offset)}`);
  return { text: parts.join(" "), values };
}

// ------------------------------------------------------------------ reading ---

type DataRow = Record<string, string | null>;

/** SQLSTATE class 22 is "data exception": a value that does not fit its type, here a forged paging position. */
const isDataException = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  typeof (error as { code?: unknown }).code === "string" &&
  (error as { code: string }).code.startsWith("22");

export async function readRows(
  db: Queryable,
  ref: TableRef,
  options: RowsOptions,
): Promise<RowPage> {
  const {
    pageSize,
    cursor,
    reveal,
    sort: requestedSort,
    filters: requestedFilters,
  } = normalizeRowsOptions(options);

  const [table] = await listTablesByRef(db, [ref]);
  if (!table) throw new DatabaseError("not_found");
  // A foreign table reads from another server, with credentials we know nothing about.
  if (table.kind === "foreign_table") throw new DatabaseError("not_supported");

  const all = await listColumns(db, ref.schema, ref.name);
  const shown = all.slice(0, ROWS_MAX_COLUMNS);
  const kinds = await findColumnKinds(db, ref);
  const columns: RowColumn[] = shown.map((c) => ({
    name: c.name,
    dataType: c.dataType,
    masked: isSensitiveColumnName(c.name) && !reveal.has(c.name),
    kind: kinds.get(c.name) ?? "other",
  }));
  const hiddenColumns = all.length - shown.length;

  const order = await findRowKey(db, ref);
  const rowSecurity = await findRowSecurity(db, ref);
  // Which column, whether it is hidden, whether its type orders, whether the table has a key to break ties.
  const sort: RowSort | null = checkRowsSort(requestedSort, columns, order);
  const filters: RowFilter[] = checkRowsFilters(requestedFilters, columns);
  if (all.length === 0) {
    return buildRowPage({
      columns,
      hiddenColumns,
      order,
      rawRows: [],
      pageSize,
      offset: 0,
      rowSecurity,
      sort,
      filters,
    });
  }

  const keyed = order.kind !== "none";
  let after: string[] | null = null;
  let afterSort: { value: string | null } | null = null;
  let offset = 0;
  if (cursor) {
    // A cursor carries the sort column's value exactly when the request sorts.
    if (
      keyed &&
      cursor.kind === "keyset" &&
      cursor.values.length === order.columns.length &&
      (cursor.sort !== undefined) === (sort !== null)
    ) {
      after = cursor.values;
      afterSort = cursor.sort ?? null;
    } else if (!keyed && cursor.kind === "offset") {
      offset = cursor.offset;
    } else {
      throw new DatabaseError("invalid_request"); // a cursor from another kind of table
    }
  }
  // A table without a key can only be read this deep; the page shrinks to fit.
  const effectiveSize = keyed
    ? pageSize
    : Math.max(0, Math.min(pageSize, ROWS_MAX_OFFSET - offset));

  const { text, values } = buildRowsQuery({
    schema: ref.schema,
    table: ref.name,
    shown: columns.flatMap((c, position) => (c.masked ? [] : [{ position, name: c.name }])),
    keyColumns: order.columns,
    after,
    sort,
    afterSort,
    filters,
    columnTypes: new Map(columns.map((c) => [c.name, c.dataType])),
    offset,
    limit: effectiveSize + 1,
  });

  let result: { rows: DataRow[] };
  try {
    result = await db.query<DataRow>(text, values);
  } catch (error) {
    // PostgreSQL's own message for a bad value contains the value ("invalid input
    // syntax for type integer: ..."): it is dropped, and a fixed message is used.
    if (isDataException(error)) throw new DatabaseError("invalid_request", { cause: error });
    throw error;
  }

  const rawRows: RawRow[] = result.rows.map((row) => ({
    cells: columns.map((c, position) => (c.masked ? null : (row[`c${position}`] ?? null))),
    key: keyed ? order.columns.map((_, i) => row[`k${i}`] ?? "") : null,
    sortValue: sort ? (row.s0 ?? null) : undefined,
  }));

  return buildRowPage({
    columns,
    hiddenColumns,
    order,
    rawRows,
    pageSize: effectiveSize,
    offset,
    rowSecurity,
    sort,
    filters,
  });
}

// ---------------------------------------------------------------- one cell ---

/**
 * One `json` or `jsonb` value of one row, whole, for the JSON editor. The statement is one fixed shape:
 *
 *   SELECT char_length(CAST("c" AS text)) AS n,
 *          CASE WHEN char_length(CAST("c" AS text)) <= $1 THEN CAST("c" AS text) END AS v
 *   FROM "s"."t" WHERE "k0" = $2 AND "k1" = $3 LIMIT 2
 *
 * The column and the key columns are catalog names (the request's names are only compared with them),
 * every value is bound, a value over the limit is measured in the database and never sent, and a
 * request that names anything but the table's whole row key is refused.
 */
export async function readCell(
  db: Queryable,
  ref: TableRef,
  request: CellRequest,
): Promise<CellRead> {
  const bad = () => new DatabaseError("invalid_request");
  const [table] = await listTablesByRef(db, [ref]);
  if (!table) throw new DatabaseError("not_found");
  if (table.kind === "foreign_table") throw new DatabaseError("not_supported");

  const columns = await listColumns(db, ref.schema, ref.name);
  const column = columns.find((c) => c.name === request.column);
  if (!column) throw bad();
  const kinds = await findColumnKinds(db, ref);
  if (kinds.get(column.name) !== "json") throw bad();
  // A hidden column would be an oracle: it is read only when it was revealed, as a page of rows does.
  if (isSensitiveColumnName(column.name) && !request.revealColumns.includes(column.name)) {
    throw bad();
  }

  const order = await findRowKey(db, ref);
  if (order.kind === "none" || request.key.length !== order.columns.length) throw bad();
  // A hidden key column would let a guess be tested: the right value answers, a wrong one is `not_found`.
  if (order.columns.some((c) => isSensitiveColumnName(c) && !request.revealColumns.includes(c))) {
    throw bad();
  }
  const given = new Map<string, string>();
  for (const part of request.key) {
    if (given.has(part.column) || !order.columns.includes(part.column)) throw bad();
    given.set(part.column, part.value);
  }

  const values: unknown[] = [CELL_EDIT_MAX_CHARS];
  const text = `CAST(${quoteIdentifier(column.name)} AS text)`;
  const where = order.columns.map((name) => {
    values.push(given.get(name));
    return `${quoteIdentifier(name)} = $${values.length}`;
  });
  const statement =
    `SELECT char_length(${text}) AS n, CASE WHEN char_length(${text}) <= $1 THEN ${text} END AS v ` +
    `FROM ${quoteQualified(ref.schema, ref.name)} WHERE ${where.join(" AND ")} LIMIT 2`;

  let result: { rows: Array<{ n: string | number | null; v: string | null }> };
  try {
    result = await db.query(statement, values);
  } catch (error) {
    // A key value that does not fit the key's type: a fixed message, never the database's (it holds the value).
    if (isDataException(error)) throw new DatabaseError("invalid_request", { cause: error });
    throw error;
  }
  const row = result.rows[0];
  if (!row || result.rows.length > 1) throw new DatabaseError("not_found");
  if (row.n === null) return { value: null, tooLarge: false };
  return row.v === null ? { value: null, tooLarge: true } : { value: row.v, tooLarge: false };
}
