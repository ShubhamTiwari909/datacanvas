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
import type { ReferentialAction, TableRef } from "./models.js";

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

export type RowChange = UpdateRowChange | InsertRowChange | DeleteRowChange;

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

export const ROW_CHANGE_KINDS = ["update_row", "insert_row", "delete_row"] as const;
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
] as const;
export type ChangeWarningCode = (typeof CHANGE_WARNING_CODES)[number];

export interface ChangeWarning {
  code: ChangeWarningCode;
  message: string;
}

/** A statement and its parameters, exactly as it will run. */
export interface PlannedStatement {
  text: string;
  values: (string | null)[];
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
}

/** The statement texts as shown to the person (values are `$1`, `$2`, ...). */
export function statementText(plan: Pick<PlannedChange, "statements">): string {
  return plan.statements.map((s) => `${s.text.trim()};`).join("\n");
}

export interface AppliedChange {
  /** Rows reported by the statements (1 for a row change). */
  rowCount: number;
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
