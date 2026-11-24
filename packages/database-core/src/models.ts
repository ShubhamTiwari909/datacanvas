/**
 * Metadata models: the vocabulary DataCanvas uses to describe a database's
 * STRUCTURE. The rows of a table (the opt-in data viewer) have their own
 * section below, `RowPage` and the types around it.
 *
 * Design rules:
 *  - Plain data only: no classes, no methods, no driver types. Every value is
 *    JSON-safe, so a model can be sent over HTTP or saved in a workspace file
 *    unchanged. (A test checks this.)
 *  - "No value" is `null`, never `undefined`, because JSON cannot carry
 *    `undefined` and a missing key is easy to confuse with a forgotten field.
 *  - The models are shaped by PostgreSQL, the first supported database, where
 *    that is honest (schemas, views, constraint kinds). When a second provider
 *    arrives, extend these models deliberately instead of pretending every
 *    database is identical.
 */

/** A namespace that groups tables (for example "public"). */
export interface SchemaInfo {
  name: string;
}

/**
 * What kind of relation a `TableInfo` describes. Views and materialized views
 * have columns like tables do, but no constraints of their own. A foreign
 * table is a table whose rows live in another database or file (for example
 * through `postgres_fdw`): its structure is read like a table's, but it has no
 * keys or indexes here and its row estimate is often unknown.
 */
export type RelationKind = "table" | "view" | "materialized_view" | "foreign_table";

/** A table or view, without its columns (those are fetched on demand). */
export interface TableInfo {
  schema: string;
  name: string;
  kind: RelationKind;
  comment: string | null;
  /**
   * Planner's row-count ESTIMATE from catalog statistics, or null if unknown.
   * Never computed by scanning the table, so it can be stale or approximate.
   */
  estimatedRowCount: number | null;
}

export interface ColumnInfo {
  name: string;
  /** Position in the table, starting at 1 (the order columns were defined). */
  ordinalPosition: number;
  /** Human-readable type as the database prints it, e.g. "integer", "character varying(255)". */
  dataType: string;
  nullable: boolean;
  /** The default expression as SQL text (e.g. "now()"), or null if there is none. */
  defaultValue: string | null;
  comment: string | null;
}

export type ConstraintKind = "primary_key" | "foreign_key" | "unique" | "check";

export interface ConstraintInfo {
  name: string;
  kind: ConstraintKind;
  /** Columns the constraint applies to, in constraint order. For a foreign key these are the referencing columns. */
  columns: string[];
  /** The constraint as SQL text (e.g. "CHECK ((quantity > 0))"), for display. */
  definition: string | null;
}

export interface IndexInfo {
  name: string;
  /**
   * Indexed columns in index order. An expression index lists the expression
   * text for that position (e.g. "lower(email)").
   */
  columns: string[];
  unique: boolean;
  /** True for the index that backs the table's primary key. */
  primary: boolean;
  /** Index access method, e.g. "btree", "gin", "hash". */
  method: string;
  /** The full CREATE INDEX statement, for display. */
  definition: string | null;
}

/** What happens to the referencing row when the referenced row is deleted or updated. */
export type ReferentialAction = "no_action" | "restrict" | "cascade" | "set_null" | "set_default";

/** One end of a relationship: a table and the columns involved. */
export interface RelationshipEnd {
  schema: string;
  table: string;
  /** Columns in constraint order. A composite key lists several; both ends line up by position. */
  columns: string[];
}

/**
 * How many rows on the target side a source row can point to, seen from the
 * SOURCE table:
 *  - "many-to-one": many source rows may reference the same target row
 *    (the normal foreign key: many orders, one user);
 *  - "one-to-one": the foreign-key columns are also unique, so each source row
 *    has its own target row.
 * (Many-to-many shows up as two many-to-one links through a junction table.)
 */
export type Cardinality = "many-to-one" | "one-to-one";

/**
 * A CONFIRMED relationship: a real foreign-key constraint declared in the
 * database. DataCanvas never reports a guess based on column names as a
 * relationship here; any user-defined or inferred links live in the workspace
 * layer, not in adapter output.
 */
export interface RelationshipInfo {
  /** Name of the foreign-key constraint. */
  name: string;
  /** The referencing side (the table that holds the foreign key). */
  source: RelationshipEnd;
  /** The referenced side (usually a primary or unique key). */
  target: RelationshipEnd;
  cardinality: Cardinality;
  onDelete: ReferentialAction;
  onUpdate: ReferentialAction;
}

/** Identifies one table, view or materialized view. */
export interface TableRef {
  schema: string;
  name: string;
}

/**
 * Everything known about ONE table, fetched together: its description plus its
 * columns, constraints and indexes. Used when many tables are needed at once
 * (the canvas), so they cost one round trip instead of several per table.
 */
export interface TableDetailsEntry {
  table: TableInfo;
  columns: ColumnInfo[];
  constraints: ConstraintInfo[];
  indexes: IndexInfo[];
}

/** What a search hit is: a table-like object, or a column of one. */
export type SearchHitKind = RelationKind | "column";

/**
 * One result of a database-wide name search. For a table, view or materialized
 * view `column` and `dataType` are null; for a column hit they describe it and
 * `schema` / `table` say where it lives.
 */
export interface SearchHit {
  kind: SearchHitKind;
  schema: string;
  table: string;
  column: string | null;
  dataType: string | null;
}

// ------------------------------------------------------------------ objects ---
//
// Everything in a database that is not a table, a column, an index or a
// foreign key: view definitions, types, sequences, functions, triggers,
// extensions and row-level-security policies. All of it is DEFINITION text and
// settings read from the catalogs; none of it reads table rows.

/** Longest piece of definition text kept (a view query, a function body). Longer text is cut to this length and ends with its full length and a fingerprint of the whole text, so a change after the cut is still noticed. */
export const MAX_OBJECT_TEXT = 20_000;

/** A table, view, materialized view or foreign table that something refers to. */
export interface ObjectRef {
  schema: string;
  name: string;
}

/** A view or materialized view: its query, and the relations that query reads. */
export interface ViewInfo {
  schema: string;
  name: string;
  materialized: boolean;
  comment: string | null;
  /** The view's SELECT, as the database prints it. */
  definition: string;
  /** Tables and views the query reads, sorted. Only relations outside the system schemas. */
  dependsOn: ObjectRef[];
}

export type TypeKind = "enum" | "composite" | "domain" | "range";

/** A user-defined type. Which of the detail fields are filled depends on `kind`; the others are empty or null. */
export interface TypeInfo {
  schema: string;
  name: string;
  kind: TypeKind;
  comment: string | null;
  /** enum: the labels, in their defined order. */
  values: string[];
  /** composite: the attributes, in order. */
  attributes: Array<{ name: string; dataType: string }>;
  /** domain: the underlying type. range: the type of its bounds. */
  baseType: string | null;
  /** domain: the default expression as SQL text. */
  defaultValue: string | null;
  /** domain: "NOT NULL" and the CHECK constraints as SQL text. */
  constraints: string[];
}

export interface SequenceInfo {
  schema: string;
  name: string;
  dataType: string;
  /** Kept as text: a bigint sequence goes beyond what a JavaScript number holds exactly. The current value is never read (it is data). */
  start: string;
  increment: string;
  min: string;
  max: string;
  cache: string;
  cycle: boolean;
  /** The table column the sequence belongs to (serial / identity columns), or null. */
  ownedBy: { schema: string; table: string; column: string } | null;
}

export type FunctionKind = "function" | "procedure";
export type Volatility = "immutable" | "stable" | "volatile";

export interface FunctionInfo {
  schema: string;
  name: string;
  kind: FunctionKind;
  /** The argument list as the database prints it, e.g. "a integer, b text". It tells overloads apart. */
  arguments: string;
  /** The result type, e.g. "integer" or "TABLE(id integer)"; null for a procedure. */
  returns: string | null;
  language: string;
  volatility: Volatility;
  securityDefiner: boolean;
  comment: string | null;
  /** The full CREATE statement, body included. */
  definition: string;
}

export type TriggerTiming = "before" | "after" | "instead_of";
export type TriggerEvent = "insert" | "update" | "delete" | "truncate";
export type TriggerState = "enabled" | "disabled" | "replica" | "always";

export interface TriggerInfo {
  schema: string;
  /** The table (or view) the trigger is on. */
  table: string;
  name: string;
  timing: TriggerTiming;
  events: TriggerEvent[];
  level: "row" | "statement";
  /** The function it runs, "schema.name". */
  function: string;
  state: TriggerState;
  definition: string;
}

export interface ExtensionInfo {
  name: string;
  version: string;
  /** The schema the extension's objects were installed in. */
  schema: string;
  comment: string | null;
}

export type PolicyCommand = "all" | "select" | "insert" | "update" | "delete";

/** A row-level-security policy. Its expressions are SQL text; no rows are evaluated. */
export interface PolicyInfo {
  schema: string;
  table: string;
  name: string;
  command: PolicyCommand;
  permissive: boolean;
  /** Role names the policy applies to; "public" means every role. */
  roles: string[];
  /** The USING expression, or null. */
  using: string | null;
  /** The WITH CHECK expression, or null. */
  withCheck: string | null;
}

/** A table that has row-level security switched on (with or without policies). */
export interface RowSecurityInfo {
  schema: string;
  table: string;
  /** FORCE ROW LEVEL SECURITY: the table's owner is subject to the policies too. */
  forced: boolean;
}

/** All of the above for one database, from one call. Every list is sorted. */
export interface DatabaseObjects {
  views: ViewInfo[];
  types: TypeInfo[];
  sequences: SequenceInfo[];
  functions: FunctionInfo[];
  triggers: TriggerInfo[];
  extensions: ExtensionInfo[];
  policies: PolicyInfo[];
  rowSecurity: RowSecurityInfo[];
}

export const OBJECT_KINDS = [
  "views",
  "types",
  "sequences",
  "functions",
  "triggers",
  "extensions",
  "policies",
  "rowSecurity",
] as const;
export type ObjectKind = (typeof OBJECT_KINDS)[number];

// -------------------------------------------------------------- index usage ---

/** How often one index has been used, from the database's own usage counters. */
export interface IndexUsage {
  schema: string;
  table: string;
  index: string;
  /** Index scans counted since the statistics were last reset. 0 means "not used since then". */
  scans: number;
  /** Disk space the index takes. */
  sizeBytes: number;
  /** The index enforces a primary key, unique or exclusion constraint, so dropping it is not an option. */
  backsConstraint: boolean;
  /** False for an index left broken by a failed CREATE INDEX CONCURRENTLY. */
  valid: boolean;
}

/**
 * Index usage for the whole database. These are statistics COUNTERS the server
 * keeps (`pg_stat_*`), not table data. Read them with their limits in mind: the
 * counters belong to THIS server only (a standby counts only the queries run on
 * it, so an index used on the primary can show 0 on a replica), they start over
 * when someone resets them, and they say nothing about a query that runs once
 * a quarter.
 */
export interface IndexUsageReport {
  /** When the counters were last reset (ISO 8601), or null when the server does not say. */
  statsReset: string | null;
  /** The server is a standby (in recovery): the counters reflect only the queries run on it. */
  inRecovery: boolean;
  indexes: IndexUsage[];
}

// ------------------------------------------------------------ table statistics ---

/**
 * What the server's statistics say about one column. A share of NULLs, a number of distinct values, a width and an
 * order: never a value (the statistics that hold values are not read). A column with `hasStatistics: false` has no
 * figures yet (the table was not analysed) or the connected role may not read it.
 */
export interface ColumnStatistics {
  column: string;
  hasStatistics: boolean;
  /** 0 to 1. */
  nullFraction: number | null;
  /** The number of distinct values, when the server counted them (an estimate from a sample). */
  distinctValues: number | null;
  /** The number of distinct values as a share of the rows, 0 to 1 (1 = every row differs), when it is not a count. */
  distinctShare: number | null;
  /** Average width in bytes of the values. */
  averageWidth: number | null;
  /** How well the values follow the physical order of the rows, -1 to 1. */
  correlation: number | null;
}

/** The disk space of one table (heap, indexes and TOAST together) and the planner's row estimate. */
export interface TableSize {
  schema: string;
  name: string;
  kind: "table" | "partitioned" | "materialized";
  /** `pg_total_relation_size`: the table, its indexes and its TOAST data (for a partitioned table, all its partitions). */
  totalBytes: number;
  tableBytes: number;
  indexBytes: number;
  estimatedRows: number | null;
}

/**
 * How much disk space a database takes, from the server's own size functions. No row is read: these are file sizes.
 * The largest tables come first; `tableCount` says how many there are in all.
 */
export interface DatabaseSizes {
  /** `pg_database_size(current_database())`, or null when the role may not see it. */
  databaseBytes: number | null;
  /** Total of the user schemas, per schema, largest first. */
  schemas: Array<{ schema: string; totalBytes: number; tables: number }>;
  tables: TableSize[];
  tableCount: number;
}

/** The size and the upkeep of a table, with the statistics of its columns. Estimates: nothing here scans the table. */
export interface TableStatistics {
  table: TableRef;
  kind: "table" | "partitioned" | "materialized";
  /** The planner's estimate of the rows (`reltuples`), or null before the first ANALYZE. */
  estimatedRows: number | null;
  liveRows: number | null;
  deadRows: number | null;
  tableBytes: number;
  indexBytes: number;
  toastBytes: number;
  /** ISO 8601 times, or null when it never happened. */
  lastVacuum: string | null;
  lastAutovacuum: string | null;
  lastAnalyze: string | null;
  lastAutoanalyze: string | null;
  columns: ColumnStatistics[];
}

// ---------------------------------------------------------------- table rows ---
//
// The ROWS of a table, read only when the caller asks for them (the opt-in
// data viewer). Everything here is bounded: rows per page, columns, characters
// per cell, size of a response and the depth of an unordered page. A cell is
// always TEXT (the database converts every value to text) or null.

/** Rows per page when the caller does not choose. */
export const ROWS_DEFAULT_PAGE_SIZE = 50;
/** The most rows in one page. */
export const ROWS_MAX_PAGE_SIZE = 200;
/** Columns read per request; a wider table says how many were left out. */
export const ROWS_MAX_COLUMNS = 100;
/** Characters of one cell kept. Longer values are cut IN THE DATABASE and flagged. */
export const ROWS_CELL_CHARS = 2000;
/** The most characters of one `json` or `jsonb` value read whole, for the JSON editor (1 MB); a larger one is not sent. */
export const CELL_EDIT_MAX_CHARS = 1_000_000;
/** About 2 MB of cell text in one response; a page that would exceed it is cut. */
export const ROWS_MAX_RESPONSE_CHARS = 2_000_000;
/** A table without a usable key can only be read this deep (OFFSET gets slower with depth). */
export const ROWS_MAX_OFFSET = 10_000;
/** A paging cursor is untrusted input: longer than this is refused. */
export const ROWS_MAX_CURSOR_CHARS = 4096;
/** The most characters of the sort column's value a cursor can carry; a page that ends on a longer value cannot be continued. */
export const ROWS_MAX_SORT_VALUE_CHARS = 1024;
/** A read with a sort (or a filter) is stopped after this long, however long a plain page is allowed to take. */
export const ROWS_SORT_FILTER_TIMEOUT_MS = 5000;

/** The most conditions in one read. */
export const ROWS_MAX_FILTERS = 10;
/** The most characters in the value of a condition. */
export const ROWS_MAX_FILTER_VALUE_CHARS = 200;
/** The most values in the list of `in`, `not_in`, `array_contains` and `array_overlaps`. */
export const ROWS_MAX_FILTER_VALUES = 50;
/** The most steps in the path of `json_path_eq`, and the most characters of one. */
export const ROWS_MAX_FILTER_PATH = 10;
export const ROWS_MAX_FILTER_PATH_CHARS = 100;
/** Conditions with the same group number match if ANY of them does; conditions without one are all required. */
export const ROWS_MAX_FILTER_GROUPS = 3;

export type RowSortDirection = "asc" | "desc";

/**
 * The filter operators. `eq` and the comparisons are typed (the value must be valid for the column's type); `neq`
 * also matches NULL; `contains`, `starts_with`, `ends_with` and `not_contains` compare literal text
 * (case-insensitive, no wildcards); `matches` is the one operator that reads its value as a case-insensitive
 * regular expression; `is_null` and `is_not_null` take no value.
 */
export const ROW_FILTER_OPS = [
  "eq",
  "neq",
  "gt",
  "gte",
  "lt",
  "lte",
  "contains",
  "starts_with",
  "ends_with",
  "not_contains",
  "matches",
  "is_empty",
  "in",
  "not_in",
  "between",
  "today",
  "last_7_days",
  "last_30_days",
  "this_month",
  "has_key",
  "json_contains",
  "json_path_eq",
  "array_contains",
  "array_overlaps",
  "array_is_empty",
  "is_null",
  "is_not_null",
] as const;
export type RowFilterOp = (typeof ROW_FILTER_OPS)[number];

/**
 * How many values an operator takes: none (`is_null`, the date shortcuts, `is_empty`, `array_is_empty`),
 * one (`value`), a list (`values`), exactly two (`between`: the two ends in `values`), or a path and a value
 * (`json_path_eq`: the steps in `path`, what it should equal in `value`).
 */
export type RowFilterShape = "none" | "one" | "list" | "two" | "path";

/**
 * One condition on a column. Conditions of a read are all required (AND), except those that share a
 * `group` number: of those, any one is enough (OR). So "A and (B or C)" is A, then B and C with the same group.
 */
export interface RowFilter {
  column: string;
  op: RowFilterOp;
  /** Text, at most `ROWS_MAX_FILTER_VALUE_CHARS`; only for the operators that take one value. */
  value?: string;
  /** Texts, each at most `ROWS_MAX_FILTER_VALUE_CHARS`, at most `ROWS_MAX_FILTER_VALUES`; for a list, or the two ends of `between`. */
  values?: string[];
  /** The steps of a path into a JSON document (`json_path_eq`), at most `ROWS_MAX_FILTER_PATH`. */
  path?: string[];
  /** 1 to `ROWS_MAX_FILTER_GROUPS`: conditions with the same number are OR-ed together. */
  group?: number;
}

/** Sort by one column. The table's key always follows as the tie-breaker, so the order is total and stable. */
export interface RowSort {
  column: string;
  direction: RowSortDirection;
}

/**
 * One cell of one row, read WHOLE (`getCell`, for the JSON editor): the row is found by the table's own key,
 * the column must be `json` or `jsonb`, and a column whose name looks sensitive is read only when named in
 * `revealColumns`, as for a page of rows.
 */
export interface CellRequest {
  column: string;
  /** One entry per column of the table's row key (`getRows` says which), in any order. */
  key: Array<{ column: string; value: string }>;
  revealColumns: string[];
}

/** What `getCell` read: the text, or null for SQL NULL, or `tooLarge` (then the text is null and nothing was sent). */
export interface CellRead {
  value: string | null;
  tooLarge: boolean;
}

export interface RowsOptions {
  /** 1 to `ROWS_MAX_PAGE_SIZE`. */
  pageSize: number;
  /** The `nextCursor` of the previous page, or null for the first page. Opaque. */
  cursor: string | null;
  /**
   * Columns whose names look sensitive are NOT read unless named here. Names
   * that are not columns of the table are ignored.
   */
  revealColumns: string[];
  /**
   * Sort by one column (null or absent: the key order). Only a column that can be
   * sorted (`canSortRows`) and is not hidden; a table without a key cannot be sorted.
   */
  sort?: RowSort | null;
  /**
   * Up to `ROWS_MAX_FILTERS` conditions: ungrouped ones are all required, and ones that share a `group` match if any one does. Only on columns that are read and not hidden,
   * with an operator the column's kind allows (`filterOpsFor`). Works on a table without a key as well.
   */
  filters?: RowFilter[];
}

/**
 * What can be done with a column's values:
 *  - "text": a string type (text, varchar, char, name, citext);
 *  - "ordered": any other type with a default btree ordering (numbers, dates and times,
 *    booleans, uuid, enums, ranges; a domain counts as its base type), except `jsonb` and
 *    `bytea`, whose order is not meaningful to a person;
 *  - "json": `json` and `jsonb` (can be searched by key, by what they contain and by a path, not sorted);
 *  - "array": any array type (can be searched by what it contains, not sorted);
 *  - "other": everything else (xml, composites, geometric types, `bytea`).
 */
export type RowColumnKind = "text" | "ordered" | "json" | "array" | "other";

export interface RowColumn {
  name: string;
  /** The type as the database prints it, e.g. "integer", "character varying(255)". */
  dataType: string;
  /** The column looks sensitive and was not read: every cell of it is empty. */
  masked: boolean;
  kind: RowColumnKind;
}

/** One value. `value` is null for SQL NULL (which is not the empty string); `truncated` says the text was cut. */
export interface RowCell {
  value: string | null;
  truncated: boolean;
}

/**
 * How the page is ordered, and so how it is paged:
 *  - "primary_key" / "unique_index": by those columns, with a cursor that holds
 *    the last row's key (as fast on page 1000 as on page 1);
 *  - "none": the table has no usable key, so the order is not guaranteed and
 *    paging is by position, down to `ROWS_MAX_OFFSET` rows.
 */
export interface RowOrder {
  kind: "primary_key" | "unique_index" | "none";
  columns: string[];
}

/**
 * Whether row-level security can hide rows from the connected role on this table.
 *  - `off`: it is not switched on for the table.
 *  - `applies`: it is on and this role is subject to it, so some rows may not be returned.
 *  - `exempt`: it is on but this role is not subject to it (a superuser, a role that
 *    bypasses it, or the table's owner when security is not forced).
 */
export type RowSecurityState = "off" | "applies" | "exempt";

export interface RowPage {
  /** The columns read, in table order (at most `ROWS_MAX_COLUMNS`). */
  columns: RowColumn[];
  /** One list of cells per row, aligned with `columns`. */
  rows: RowCell[][];
  /** Pass to the next call for the following page, or null when there is no more to read. */
  nextCursor: string | null;
  order: RowOrder;
  /** Columns of the table that were left out because it has more than `ROWS_MAX_COLUMNS`. */
  hiddenColumns: number;
  /** The page was shortened because it would have exceeded the response size limit. */
  cutBySize: boolean;
  /** An unordered table has more rows, but past `ROWS_MAX_OFFSET`: they cannot be reached. */
  offsetCapped: boolean;
  /** Whether the rows shown may be only some of the table's rows because of row-level security. */
  rowSecurity: RowSecurityState;
  /** The sort that was applied, or null for the key order. */
  sort: RowSort | null;
  /** The conditions that were applied, in the order given. */
  filters: RowFilter[];
  /** The page ended on a sort value too long to continue from, so there is no next page. */
  sortValueTooLong: boolean;
}
