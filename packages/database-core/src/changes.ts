/**
 * Changes to a database: editing rows and designing tables (1.4.0, see
 * `docs/data-editing-plan.md`).
 *
 * A change is a STRUCTURED OPERATION, never SQL. The browser sends one of the
 * `Change` shapes below; the adapter checks every name against the catalog,
 * takes types and defaults from fixed lists, binds every value as a parameter,
 * and builds the statement itself. There is no field that holds SQL, a WHERE
 * clause or an expression, so "no text typed by the user becomes SQL" stays
 * true for writes as it is for reads.
 *
 * Column values travel as TEXT and are cast by the database to the column's
 * own type; `null` means SQL NULL, which is not the same as the empty string.
 * Lists of `{ column, value }` are used instead of objects keyed by column
 * name, so a column called `__proto__` or `constructor` is just a name.
 */
import type { ReferentialAction, RowFilter, TableRef } from "./models.js";

// ----------------------------------------------------------------- limits ---

/** PostgreSQL's limit on a name, in bytes (NAMEDATALEN - 1). */
export const MAX_IDENTIFIER_BYTES = 63;
/** Columns in one new table, or set in one row change. */
export const MAX_CHANGE_COLUMNS = 100;
/** Characters in one value of a row change, or in a literal default. */
export const MAX_CHANGE_VALUE_CHARS = 100_000;
/** Characters in a comment on a table or column. */
export const MAX_COMMENT_CHARS = 2000;
/** Unique constraints, foreign keys or index columns in one change. */
export const MAX_CHANGE_PARTS = 32;

/** Rows in one bulk change (`update_rows`, `delete_rows`): the rows are chosen one by one, by key. */
export const MAX_BULK_ROWS = 500;

/** Limits of an import (`insert_rows`): rows, columns, characters in one cell, and rows in one statement. */
export const IMPORT_MAX_ROWS = 100_000;
export const IMPORT_MAX_COLUMNS = 50;
export const IMPORT_MAX_CELL_CHARS = 10_000;
export const IMPORT_BATCH_ROWS = 500;
/** The largest file an import reads (the browser parses it; the server gets the rows). */
export const IMPORT_MAX_FILE_BYTES = 20 * 1024 * 1024;

/**
 * Limits of a change of the rows a filter matches (`update_matching`, `delete_matching`; `docs/write-side-v2-plan.md`,
 * 6.6 and 13.4): the rows, the characters of every key value the plan holds (counted as the preview reads them; a
 * character outside Latin-1 takes two bytes, so up to about 16 MB), and the characters of one key value.
 */
export const MATCHING_MAX_ROWS = 100_000;
export const MATCHING_MAX_KEY_CHARS = 8_000_000;
export const MATCHING_MAX_KEY_VALUE_CHARS = 4_096;

/** How long a preview can be applied, and how long a lock may be waited for. */
export const PREVIEW_TTL_MS = 5 * 60 * 1000;
export const WRITE_LOCK_TIMEOUT_MS = 3_000;
/** Statement timeouts: a row change, and a change of structure (decision 128). */
export const ROW_CHANGE_TIMEOUT_MS = 15_000;
export const STRUCTURE_CHANGE_TIMEOUT_MS = 60_000;

// ------------------------------------------------------------ row changes ---

/** One column and its new value as text; `null` is SQL NULL. */
export interface ColumnValue {
  column: string;
  value: string | null;
}

/** One column of a row's key and its value as text (key columns are never NULL). */
export interface KeyValue {
  column: string;
  value: string;
}

/**
 * Change some columns of ONE row, found by its key. `expected` holds what the
 * person saw in each changed column; the row is changed only if every one of
 * them still holds that (as text), otherwise nothing is written and the error
 * is `row_changed`.
 */
export interface UpdateRowChange {
  kind: "update_row";
  table: TableRef;
  key: KeyValue[];
  set: ColumnValue[];
  expected: ColumnValue[];
}

/** Add one row. A column that is left out gets its default. */
export interface InsertRowChange {
  kind: "insert_row";
  table: TableRef;
  values: ColumnValue[];
}

/** Delete ONE row, found by its key. */
export interface DeleteRowChange {
  kind: "delete_row";
  table: TableRef;
  key: KeyValue[];
}

/** One row of a bulk change: its key, and (for an update) what the person saw in each column that is set. */
export interface BulkRow {
  key: KeyValue[];
  /** The value the person saw in each column that is set, as text; empty for a delete. */
  expected: ColumnValue[];
}

/**
 * Set the SAME values on several rows (at most `MAX_BULK_ROWS`), each found by its key. Each row carries what the
 * person saw in the columns that are set, and a row that no longer holds it is left out (and reported at preview,
 * before anything is written). At apply, every row must be changed exactly once or nothing is.
 */
export interface UpdateRowsChange {
  kind: "update_rows";
  table: TableRef;
  set: ColumnValue[];
  rows: BulkRow[];
}

/** Delete several rows (at most `MAX_BULK_ROWS`), each found by its key. Each must be deleted exactly once or none is. */
export interface DeleteRowsChange {
  kind: "delete_rows";
  table: TableRef;
  rows: Array<{ key: KeyValue[] }>;
}

/**
 * Add many rows from an import (`docs/advanced-data-workspace-plan.md`, section 9; decision 160): the columns that
 * are given, and one list of values per row, each as long as `columns` (`null` is SQL NULL). The rows go in
 * batches of `IMPORT_BATCH_ROWS`, one statement each, in one transaction: every batch inserts exactly the rows it
 * was planned for or nothing is added. A column that is left out gets its default.
 */
export interface InsertRowsChange {
  kind: "insert_rows";
  table: TableRef;
  columns: string[];
  rows: Array<Array<string | null>>;
}

/**
 * Update or insert from an import (`docs/write-side-v2-plan.md`, 4.1 and 13.1): the `insert_rows` batch with
 * `ON CONFLICT (key) DO UPDATE SET` the `updateColumns` (or `DO NOTHING` when that list is empty). `key` names the
 * columns of one of the table's own primary-key or unique constraints; the server checks at preview that it is
 * exactly one (not partial, not on expressions, not deferrable, every column NOT NULL) and that every key column
 * is among `columns`. `updateColumns` are mapped columns outside every unique key of the table. Two rows of the
 * file with the same key are refused at preview. The preview counts the rows that already exist.
 */
export interface UpsertRowsChange {
  kind: "upsert_rows";
  table: TableRef;
  key: string[];
  columns: string[];
  rows: Array<Array<string | null>>;
  updateColumns: string[];
}

/**
 * Update only, by key, from an import (`docs/write-side-v2-plan.md`, 4.2 and 13.2): each row of the file sets the
 * columns that are not the key on the row its key finds. `key` follows the rules of `UpsertRowsChange`. Rows that
 * find no row are left out at preview (`skipped`); a repeated key is refused before planning.
 */
export interface UpdateByKeyChange {
  kind: "update_by_key";
  table: TableRef;
  key: string[];
  columns: string[];
  rows: Array<Array<string | null>>;
}

/**
 * Set ONE value on every row a filter matches (`docs/write-side-v2-plan.md`, section 6). `filters` are the page
 * reader's own conditions (`RowsOptions.filters`), at least one: an empty filter is refused, never "the whole
 * table". `revealColumns` are the columns whose names look sensitive that the person revealed, as for a page of
 * rows: a condition on a hidden column is refused, and so is setting one. The filter is used only by the READ of
 * the preview, which finds the keys of the matching rows (at most `MATCHING_MAX_ROWS`) and holds them; apply
 * updates exactly those keys in keyed batches, and never compares the values the rows hold (decision 3).
 */
export interface UpdateMatchingChange {
  kind: "update_matching";
  table: TableRef;
  filters: RowFilter[];
  revealColumns: string[];
  set: ColumnValue;
}

/** Delete every row a filter matches: as `UpdateMatchingChange`, without the value. */
export interface DeleteMatchingChange {
  kind: "delete_matching";
  table: TableRef;
  filters: RowFilter[];
  revealColumns: string[];
}

export type RowChange =
  | UpdateRowChange
  | InsertRowChange
  | DeleteRowChange
  | UpdateRowsChange
  | DeleteRowsChange
  | InsertRowsChange
  | UpsertRowsChange
  | UpdateByKeyChange
  | UpdateMatchingChange
  | DeleteMatchingChange;

// ------------------------------------------------------- column definitions ---

/** The types a column can be given in the table builder (an allow-list, decision 124). */
export const COLUMN_TYPE_NAMES = [
  "smallint",
  "integer",
  "bigint",
  "numeric",
  "real",
  "double precision",
  "boolean",
  "text",
  "varchar",
  "char",
  "date",
  "time",
  "timestamp",
  "timestamptz",
  "interval",
  "uuid",
  "json",
  "jsonb",
  "bytea",
  "inet",
] as const;
export type ColumnTypeName = (typeof COLUMN_TYPE_NAMES)[number];

/** Types that take a length (`varchar(n)`, `char(n)`). */
export const LENGTH_TYPES: readonly ColumnTypeName[] = ["varchar", "char"];
/** The largest length of `varchar(n)` and `char(n)`. */
export const MAX_TYPE_LENGTH = 10_485_760;
/** The largest precision of `numeric(p, s)`. */
export const MAX_NUMERIC_PRECISION = 1000;
/** Types that can be an identity column. */
export const IDENTITY_TYPES: readonly ColumnTypeName[] = ["smallint", "integer", "bigint"];

/**
 * A type from the allow-list with its parameters. `length` only for varchar
 * and char (optional for varchar); `precision` and `scale` only for numeric
 * (both optional, scale needs precision); `array` makes it `type[]`.
 */
export interface ColumnType {
  name: ColumnTypeName;
  length?: number;
  precision?: number;
  scale?: number;
  array?: boolean;
}

/**
 * A default value, chosen from a fixed list instead of typed as an
 * expression. A `literal` is text cast to the column's type in the database.
 * `gen_random_uuid` exists from PostgreSQL 13, and on 12 only when an
 * extension provides it.
 */
export type ColumnDefault =
  | { kind: "none" }
  | { kind: "literal"; value: string }
  | { kind: "now" }
  | { kind: "current_date" }
  | { kind: "gen_random_uuid" }
  | { kind: "boolean"; value: boolean };

export type IdentityKind = "always" | "by_default";

export interface ColumnDefinition {
  name: string;
  type: ColumnType;
  nullable: boolean;
  /** Must be `none` for an identity column. */
  default: ColumnDefault;
  /** `GENERATED ... AS IDENTITY` (replaces `serial`); null for an ordinary column. */
  identity: IdentityKind | null;
  comment: string | null;
}

/** A foreign key to existing columns (or, in a new table, to its own). */
export interface ForeignKeyDefinition {
  columns: string[];
  references: { schema: string; table: string; columns: string[] };
  onDelete: ReferentialAction;
  onUpdate: ReferentialAction;
}

// ------------------------------------------------------- structure changes ---

export interface CreateTableChange {
  kind: "create_table";
  schema: string;
  name: string;
  columns: ColumnDefinition[];
  /** Columns of the primary key, empty for none. */
  primaryKey: string[];
  /** Each entry is one unique constraint over those columns. */
  unique: string[][];
  foreignKeys: ForeignKeyDefinition[];
  comment: string | null;
}

export interface AddColumnChange {
  kind: "add_column";
  table: TableRef;
  column: ColumnDefinition;
}

export interface RenameColumnChange {
  kind: "rename_column";
  table: TableRef;
  column: string;
  to: string;
}

export interface RenameTableChange {
  kind: "rename_table";
  table: TableRef;
  to: string;
}

/** Only where PostgreSQL has an implicit or assignment cast; never a USING expression (decision 132). */
export interface AlterColumnTypeChange {
  kind: "alter_column_type";
  table: TableRef;
  column: string;
  type: ColumnType;
}

export interface SetNullableChange {
  kind: "set_nullable";
  table: TableRef;
  column: string;
  nullable: boolean;
}

/** `{ kind: "none" }` drops the default. */
export interface SetDefaultChange {
  kind: "set_default";
  table: TableRef;
  column: string;
  default: ColumnDefault;
}

export interface AddPrimaryKeyChange {
  kind: "add_primary_key";
  table: TableRef;
  columns: string[];
}

export interface AddUniqueChange {
  kind: "add_unique";
  table: TableRef;
  columns: string[];
}

export interface AddForeignKeyChange {
  kind: "add_foreign_key";
  table: TableRef;
  foreignKey: ForeignKeyDefinition;
}

/** A primary key, unique or foreign key constraint, by name. Refused while anything depends on it. */
export interface DropConstraintChange {
  kind: "drop_constraint";
  table: TableRef;
  constraint: string;
}

/** A plain (not concurrent) index, named by the database (decision 133). */
export interface CreateIndexChange {
  kind: "create_index";
  table: TableRef;
  columns: string[];
  unique: boolean;
}

/** An index that does not back a constraint (drop the constraint instead). */
export interface DropIndexChange {
  kind: "drop_index";
  table: TableRef;
  index: string;
}

/** `confirm` must be the table's name, typed by the person. Refused while anything depends on the column. */
export interface DropColumnChange {
  kind: "drop_column";
  table: TableRef;
  column: string;
  confirm: string;
}

/** `confirm` must be the table's name, typed by the person. Refused while anything depends on the table. */
export interface DropTableChange {
  kind: "drop_table";
  table: TableRef;
  confirm: string;
}

export type StructureChange =
  | CreateTableChange
  | AddColumnChange
  | RenameColumnChange
  | RenameTableChange
  | AlterColumnTypeChange
  | SetNullableChange
  | SetDefaultChange
  | AddPrimaryKeyChange
  | AddUniqueChange
  | AddForeignKeyChange
  | DropConstraintChange
  | CreateIndexChange
  | DropIndexChange
  | DropColumnChange
  | DropTableChange;

export type Change = RowChange | StructureChange;
export type ChangeKind = Change["kind"];

export const ROW_CHANGE_KINDS = [
  "update_row",
  "insert_row",
  "delete_row",
  "update_rows",
  "delete_rows",
  "insert_rows",
  "upsert_rows",
  "update_by_key",
  "update_matching",
  "delete_matching",
] as const;
/** The changes of the rows a filter matches: their keys are found at preview, and the count is typed to apply. */
export const MATCHING_CHANGE_KINDS = ["update_matching", "delete_matching"] as const;
export const STRUCTURE_CHANGE_KINDS = [
  "create_table",
  "add_column",
  "rename_column",
  "rename_table",
  "alter_column_type",
  "set_nullable",
  "set_default",
  "add_primary_key",
  "add_unique",
  "add_foreign_key",
  "drop_constraint",
  "create_index",
  "drop_index",
  "drop_column",
  "drop_table",
] as const satisfies readonly StructureChange["kind"][];

/** Changes that destroy something: the person must tick that they read the preview. */
export const DESTRUCTIVE_CHANGE_KINDS: readonly ChangeKind[] = [
  "delete_row",
  "delete_rows",
  // It overwrites existing rows (an upsert is destructive only when its preview finds rows it would overwrite).
  "update_by_key",
  // Like an update by key, it overwrites rows without comparing what they hold: always the tick (and the typed count).
  "update_matching",
  "delete_matching",
  "drop_constraint",
  "drop_index",
  "drop_column",
  "drop_table",
];

export function isRowChange(change: Change): change is RowChange {
  return (ROW_CHANGE_KINDS as readonly string[]).includes(change.kind);
}

/** The table a change is about (for a new table, the table it creates). */
export function changeTable(change: Change): TableRef {
  return change.kind === "create_table"
    ? { schema: change.schema, name: change.name }
    : change.table;
}

/**
 * The column names a change touches, for the session history (which records
 * names, never values).
 */
export function changeColumns(change: Change): string[] {
  switch (change.kind) {
    case "update_row":
      return change.set.map((v) => v.column);
    case "insert_row":
      return change.values.map((v) => v.column);
    case "delete_row":
      return change.key.map((k) => k.column);
    case "update_rows":
      return change.set.map((v) => v.column);
    case "delete_rows":
      return (change.rows[0]?.key ?? []).map((k) => k.column);
    case "insert_rows":
    case "upsert_rows":
    case "update_by_key":
      return [...change.columns];
    case "update_matching":
      return [change.set.column];
    case "delete_matching":
      // The rows were found by these columns (names only: never a condition's value or operator).
      return [...new Set(change.filters.map((f) => f.column))];
    case "create_table":
      return change.columns.map((c) => c.name);
    case "add_column":
      return [change.column.name];
    case "rename_column":
      return [change.column, change.to];
    case "alter_column_type":
    case "set_nullable":
    case "set_default":
    case "drop_column":
      return [change.column];
    case "add_primary_key":
    case "add_unique":
    case "create_index":
      return [...change.columns];
    case "add_foreign_key":
      return [...change.foreignKey.columns];
    case "rename_table":
    case "drop_constraint":
    case "drop_index":
    case "drop_table":
      return [];
  }
}

/**
 * Does the change carry text the person typed into the statement itself: a
 * literal default or a comment? Such a change of structure is still shown to
 * the person exactly, but its SQL is not kept in the session history, which is
 * names only (decision 131).
 */
export function changeCarriesUserText(change: Change): boolean {
  const column = (c: ColumnDefinition): boolean =>
    c.default.kind === "literal" || (c.comment !== null && c.comment !== "");
  switch (change.kind) {
    case "create_table":
      return (change.comment !== null && change.comment !== "") || change.columns.some(column);
    case "add_column":
      return column(change.column);
    case "set_default":
      return change.default.kind === "literal";
    default:
      return false;
  }
}

// --------------------------------------------------------------- previews ---

/** Why the preview warns. Each code has a fixed explanation; `message` may name structure, never values. */
export const CHANGE_WARNING_CODES = [
  /** Triggers on the table will run. */
  "triggers",
  /** Row-level security may hide the row from the connected role. */
  "row_security",
  /** Other tables' foreign keys point at the row or the key being changed. */
  "referenced",
  /** Takes a lock that blocks reads and writes of the table until it commits. */
  "lock",
  /** Rewrites the whole table. */
  "rewrite",
  /** Reads every row of the table (for example to check NOT NULL or a foreign key). */
  "scan",
  /** Views, functions or code may use the old name. */
  "renamed",
  /** Cannot be undone. */
  "destructive",
  /** May fail when the table already has rows. */
  "may_fail",
  /** Values may be rounded or cut to fit a narrower type. */
  "lossy",
] as const;
export type ChangeWarningCode = (typeof CHANGE_WARNING_CODES)[number];

export interface ChangeWarning {
  code: ChangeWarningCode;
  message: string;
}

/** A statement and its parameters, exactly as it will run. */
export interface PlannedStatement {
  text: string;
  /** Each value is a text, `null`, or (for an import) a list of them: one list per column of a batch. */
  values: (string | null | Array<string | null>)[];
  /** When set, the statement must report exactly this many rows or the whole change is rolled back. */
  expectRows?: number;
  /**
   * An upsert batch that returns one boolean per row it wrote, `inserted` (`RETURNING (xmax = 0) AS inserted`):
   * applying counts the inserted and updated rows from it. Nothing else comes back (never a value).
   */
  countsInserted?: boolean;
}

/**
 * What the preview of an import by key found, before anything is written (counts only, never a key or a value):
 * how many rows of the file are new (`insert`), how many find a row that will be overwritten (`update`), and how
 * many find a row that is left as it is (`unchanged`: an upsert with no column to update).
 */
export interface RowCounts {
  insert: number;
  update: number;
  unchanged: number;
}

/** The part of an `AbortSignal` that applying a change looks at between statements (no DOM types here). */
export interface CancelSignal {
  readonly aborted: boolean;
}

/** A column a plan was made against: its name and its position in the table (`attnum`) at that time. */
export interface PlanGuardColumn {
  name: string;
  attnum: number;
  /** The column's type as the database prints it (`format_type`, length and precision included) at preview time: a changed type makes the plan stale. */
  dataType: string;
}

/**
 * A relation the plan was checked against, as it was at preview time. `oid` and
 * the columns' positions tell a table from a table that was dropped and
 * created again under the same name. `lock` is taken before the statements run,
 * and the identity checked under it (`none`: checked, not locked).
 */
export interface PlanGuardRelation {
  schema: string;
  name: string;
  oid: string;
  columns: PlanGuardColumn[];
  lock: "none" | "row_exclusive" | "share" | "access_exclusive";
}

/**
 * What apply re-validates (optional: a plan without a guard runs as before).
 * A plan can be minutes old; without this a table dropped and recreated in
 * between would receive the change.
 */
export interface PlanGuard {
  relations: PlanGuardRelation[];
}

/**
 * What `previewChange` returns: everything needed to show the change and later
 * run EXACTLY it. Held on the server (never sent to the browser as is: the
 * parameters are the person's values).
 */
export interface PlannedChange {
  change: Change;
  statements: PlannedStatement[];
  /** `one_row`: each statement must report exactly one row, or everything rolls back. */
  expect: "one_row" | "any";
  category: "row" | "structure";
  /** One plain sentence: what will happen. */
  effect: string;
  warnings: ChangeWarning[];
  destructive: boolean;
  /** The identity of what the plan was checked against, verified again at apply. */
  guard?: PlanGuard;
  /**
   * For a bulk change: the positions (0-based, in the request) of rows that no longer hold what the person saw,
   * or no longer exist. They are NOT in `statements`: the plan changes the other rows only.
   */
  skipped?: number[];
  /** For `upsert_rows` and `update_by_key`: what the preview counted (see `RowCounts`). */
  counts?: RowCounts;
  /**
   * For a change of the rows a filter matches: how many rows the preview found and the plan holds the keys of. The
   * person types this number to apply, and the write service compares what was typed with it before the plan runs.
   */
  confirmRows?: number;
}

/** The statement texts as shown to the person (values are `$1`, `$2`, ...). */
export function statementText(plan: Pick<PlannedChange, "statements">): string {
  // A bulk change is the same statement for many rows: it is shown once, with how many times it runs.
  const lines: string[] = [];
  for (let i = 0; i < plan.statements.length;) {
    const text = plan.statements[i]!.text.trim();
    let same = 1;
    while (plan.statements[i + same]?.text.trim() === text) same += 1;
    lines.push(`${text};`);
    const batch = plan.statements[i]!.expectRows;
    if (same > 1) {
      lines.push(
        batch === undefined
          ? `-- the same statement runs for each of ${same} rows (the values differ)`
          : `-- the same statement runs for each of ${same} batches of up to ${batch} rows (the values differ)`,
      );
    }
    i += same;
  }
  return lines.join("\n");
}

export interface AppliedChange {
  /** Rows reported by the statements (1 for a row change). */
  rowCount: number;
  /**
   * For `upsert_rows` and `update_by_key`: how the rows written split. `exact` is false when the database could not
   * say row by row (an upsert into a partitioned table, or a role that may not read the table): the numbers are
   * then the preview's estimate, and only their sum (`rowCount`) was checked.
   */
  split?: { inserted: number; updated: number; exact: boolean };
}

// ----------------------------------------------------- editing a table: info ---

/** Why a table's rows cannot be edited. */
export type NotEditableReason =
  "not_a_table" | "no_key" | "foreign_table" | "partition_of_other" | "not_found";

export interface EditableColumn {
  name: string;
  /** As the database prints it (`format_type`), e.g. "character varying(255)". */
  dataType: string;
  nullable: boolean;
  hasDefault: boolean;
  /** `GENERATED ALWAYS` identity or a generated column: the database fills it, never the person. */
  generated: boolean;
  identity: IdentityKind | null;
  /** False for types with no useful text editing in the first version (`bytea`). */
  editable: boolean;
  /** Whether the column is part of the key used to find a row. */
  inKey: boolean;
}

export interface IncomingForeignKey {
  name: string;
  /** The table the foreign key belongs to. */
  from: { schema: string; table: string; columns: string[] };
  /** The columns of this table it points at. */
  columns: string[];
  onDelete: ReferentialAction;
  onUpdate: ReferentialAction;
}

/** What the row editor needs to know about one table (catalog only, no rows). */
export interface TableEditInfo {
  table: TableRef;
  editable: boolean;
  reason: NotEditableReason | null;
  /** The key a row is found by: the primary key, or a unique index on NOT NULL columns. */
  key: string[];
  columns: EditableColumn[];
  /** Names of the enabled user triggers that fire on row changes. */
  triggers: string[];
  /** Row-level security may hide rows from the connected role. */
  rowSecurity: boolean;
  incomingForeignKeys: IncomingForeignKey[];
  /**
   * The keys an import by key may use (`upsert_rows`, `update_by_key`): the table's primary key and unique
   * constraints that are not partial, not on expressions, not deferrable, with every column NOT NULL. Structure
   * only. Optional so that older callers keep working; the PostgreSQL adapter always fills it.
   */
  uniqueKeys?: UniqueKeyInfo[];
}

/** A constraint an import by key may use: its name and its columns, in the constraint's order. */
export interface UniqueKeyInfo {
  name: string;
  columns: string[];
}

// --------------------------------------------------------------- the role ---

/** What the connected role can do, read from the catalog (decision 126). No rows are read. */
export interface RoleInfo {
  roleName: string;
  superuser: boolean;
  createRole: boolean;
  createDb: boolean;
  bypassRls: boolean;
  /** Membership of predefined roles that can write anywhere or reach the server's files and programs. */
  powerfulRoles: string[];
  /** `CREATE` on the current database. */
  canCreateInDatabase: boolean;
  /** How many user schemas the role has `CREATE` on. */
  schemasWithCreate: number;
  /** How many user tables the role can INSERT, UPDATE, DELETE or TRUNCATE (capped by the query). */
  writableTables: number;
  /** The address the server reports (`inet_server_addr()`), or null over a Unix socket. */
  serverAddress: string | null;
}

export type RoleWarningCode =
  | "superuser"
  | "can_write"
  | "can_create"
  | "create_role"
  | "create_db"
  | "bypass_rls"
  | "server_files";

export interface RoleWarning {
  code: RoleWarningCode;
  message: string;
}

const POWERFUL_SERVER_ROLES = new Set([
  "pg_execute_server_program",
  "pg_write_server_files",
  "pg_read_server_files",
]);

/**
 * Warnings for a role that can do more than the current mode needs. Read-only
 * browsing needs SELECT; with writes unlocked, the rights the changes need.
 * Information, never a block.
 */
export function roleWarnings(role: RoleInfo, mode: "read" | "write"): RoleWarning[] {
  const warnings: RoleWarning[] = [];
  if (role.superuser) {
    warnings.push({
      code: "superuser",
      message:
        mode === "read"
          ? "This database role is a superuser. For browsing, a read-only role is safer."
          : "This role is a superuser. It can do far more than editing tables. A role that owns only this database is safer.",
    });
  }
  if (mode === "read") {
    if (
      !role.superuser &&
      (role.writableTables > 0 || role.powerfulRoles.includes("pg_write_all_data"))
    ) {
      warnings.push({
        code: "can_write",
        message: "This database role can change data. For browsing, a read-only role is safer.",
      });
    }
    if (!role.superuser && (role.canCreateInDatabase || role.schemasWithCreate > 0)) {
      warnings.push({
        code: "can_create",
        message: "This database role can create objects. For browsing, a read-only role is safer.",
      });
    }
    return warnings;
  }
  if (role.superuser) return warnings;
  if (role.createRole) {
    warnings.push({
      code: "create_role",
      message: "This role can create roles. Editing tables does not need that.",
    });
  }
  if (role.createDb) {
    warnings.push({
      code: "create_db",
      message: "This role can create databases. Editing tables does not need that.",
    });
  }
  if (role.bypassRls) {
    warnings.push({
      code: "bypass_rls",
      message: "This role bypasses row-level security, so it can change rows other roles cannot.",
    });
  }
  if (role.powerfulRoles.some((name) => POWERFUL_SERVER_ROLES.has(name))) {
    warnings.push({
      code: "server_files",
      message:
        "This role can read or write files, or run programs, on the database server. Editing tables does not need that.",
    });
  }
  return warnings;
}

// ------------------------------------------------------------------ names ---

/** Length of a name in bytes, as PostgreSQL counts it. */
export function identifierBytes(name: string): number {
  let bytes = 0;
  for (const char of name) {
    const code = char.codePointAt(0) ?? 0;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
}

/**
 * Is this a name the table builder may create? Not empty, at most 63 bytes,
 * no NUL character (the database refuses it), no leading or trailing space
 * (almost always a typing mistake). Any other character is fine: names are
 * always quoted.
 */
export function isValidNewIdentifier(name: string): boolean {
  return (
    name.length > 0 &&
    identifierBytes(name) <= MAX_IDENTIFIER_BYTES &&
    !name.includes("\0") &&
    name.trim() === name
  );
}
