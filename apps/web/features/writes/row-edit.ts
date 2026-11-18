/**
 * The rules of the row editor, as pure functions (no React), so they are
 * tested on their own: which cells and rows can be edited and why not, how a
 * row is found, how an editor's state becomes a `Change`, and the "before and
 * after" table the preview shows.
 *
 * The before and after values are built HERE, from what the person saw and
 * typed. The server never sends a value back (decision 129); a preview only
 * carries the statement, the effect and the warnings.
 */
import type {
  DeleteRowChange,
  EditableColumn,
  InsertRowChange,
  KeyValue,
  NotEditableReason,
  RowCell,
  RowColumn,
  TableEditInfo,
  TableRef,
  UpdateRowChange,
} from "@datacanvas/database-core";

// ------------------------------------------------------------- the words ---

/** Why a table's rows cannot be edited, in plain words. */
export function notEditableText(reason: NotEditableReason | null): string {
  switch (reason) {
    case "not_a_table":
      return "This is a view or a materialized view. Its rows cannot be edited here.";
    case "no_key":
      return "This table has no primary key and no unique index on columns that cannot be empty, so a single row cannot be found safely. Its rows cannot be edited here.";
    case "foreign_table":
      return "The rows of a foreign table live on another server. They cannot be edited here.";
    case "partition_of_other":
      return "This is a partition of another table. Edit its rows through the partitioned table.";
    case "not_found":
      return "This table no longer exists.";
    case null:
      return "The rows of this table cannot be edited here.";
  }
}

/** A short hint of what a value of this type looks like, or null when there is nothing useful to say. */
export function typeHint(dataType: string): string | null {
  const type = dataType.toLowerCase();
  if (type.endsWith("[]")) return 'An array, such as {1,2,3} or {"a","b"}.';
  if (/^(smallint|integer|bigint)\b/.test(type)) return "A whole number.";
  if (/^(numeric|decimal|real|double precision)\b/.test(type))
    return "A number, with a dot for decimals.";
  if (type === "boolean") return "true or false.";
  if (type === "date") return "A date, such as 2026-11-16.";
  if (type.startsWith("timestamp") && type.includes("with time zone"))
    return "A date and time, such as 2026-11-16 14:30:00+00.";
  if (type.startsWith("timestamp")) return "A date and time, such as 2026-11-16 14:30:00.";
  if (type.startsWith("time")) return "A time, such as 14:30:00.";
  if (type === "interval") return "A duration, such as 2 hours or 3 days.";
  if (type === "uuid") return "A UUID, such as 123e4567-e89b-12d3-a456-426614174000.";
  if (type === "json" || type === "jsonb") return 'JSON, such as {"a": 1}.';
  if (type === "inet" || type === "cidr") return "An IP address, such as 192.168.0.1.";
  return null;
}

/** Which kind of control fits a column's type (docs/ui-polish-plan.md, U2). */
export type ControlKind =
  /** A switch: true or false. */
  | "boolean"
  /** A one-line field for a number (the numeric keypad on a phone). */
  | "number"
  /** A one-line field for a short, structured value: a date, a time, a UUID, an address. */
  | "line"
  /** A field that grows with its text: text, JSON, arrays and anything else that can be long. */
  | "text";

export function controlKind(dataType: string): ControlKind {
  const type = dataType.toLowerCase();
  if (type.endsWith("[]")) return "text";
  if (type === "boolean") return "boolean";
  if (/^(smallint|integer|bigint|numeric|decimal|real|double precision)\b/.test(type))
    return "number";
  if (
    type === "date" ||
    type.startsWith("time") ||
    type === "interval" ||
    type === "uuid" ||
    type === "inet" ||
    type === "cidr"
  )
    return "line";
  return "text";
}

/** Does a boolean's text mean true? (The database writes `true`; typed forms are accepted.) */
export function isTrueText(text: string): boolean {
  return /^(t|true|y|yes|on|1)$/i.test(text.trim());
}

/**
 * The column to focus when a row editor opens: the one the person started from,
 * else the first editable column that is not part of the key (a key is rarely
 * what they came to change), else the first editable one.
 */
export function focusTarget(
  requested: string | null,
  columns: readonly { name: string; editable: boolean; inKey: boolean }[],
): string | null {
  const editable = columns.filter((c) => c.editable);
  if (requested !== null && editable.some((c) => c.name === requested)) return requested;
  return (editable.find((c) => !c.inKey) ?? editable[0])?.name ?? null;
}

/**
 * A quick check of a typed value, for convenience only: the database decides.
 * Returns a sentence (that never repeats the value) or null.
 */
export function checkValue(dataType: string, value: string): string | null {
  const type = dataType.toLowerCase();
  if (type.endsWith("[]")) return null;
  if (/^(smallint|integer|bigint)\b/.test(type) && !/^\s*[-+]?\d+\s*$/.test(value))
    return "This column takes a whole number.";
  if (
    /^(numeric|decimal|real|double precision)\b/.test(type) &&
    !/^\s*([-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?|NaN|[-+]?Infinity)\s*$/.test(value)
  )
    return "This column takes a number.";
  if (type === "boolean" && !/^\s*(t|f|true|false|yes|no|on|off|1|0|y|n)\s*$/i.test(value))
    return "This column takes true or false.";
  if (type === "json" || type === "jsonb") {
    try {
      JSON.parse(value);
    } catch {
      return "This column takes JSON, and this is not valid JSON.";
    }
  }
  return null;
}

// ------------------------------------------------------------- editability ---

/** Why this column cannot be edited at all (whatever the row), or null when it can. */
export function columnEditBlock(
  column: Pick<RowColumn, "masked">,
  info: EditableColumn | undefined,
): string | null {
  if (!info) return "This column cannot be edited here.";
  if (column.masked) return "This column is hidden. Show it first to edit it.";
  if (info.generated) return "The database fills this column.";
  if (!info.editable) return "Values of this type cannot be edited here.";
  return null;
}

/** Why this one cell cannot be edited, or null when it can. */
export function cellEditBlock(
  column: Pick<RowColumn, "masked">,
  cell: RowCell,
  info: EditableColumn | undefined,
): string | null {
  const block = columnEditBlock(column, info);
  if (block) return block;
  if (cell.truncated) return "Only part of this value was read, so it cannot be edited here.";
  return null;
}

export type RowAddress = { ok: true; key: KeyValue[] } | { ok: false; reason: string };

/**
 * The key a row is found by, from the cells on screen. A row cannot be
 * addressed when a key column is not on the page, is hidden, was cut, or is
 * NULL (which a key never is, but the page might not show it).
 */
export function rowAddress(
  columns: readonly Pick<RowColumn, "name" | "masked">[],
  row: readonly RowCell[],
  info: Pick<TableEditInfo, "editable" | "key" | "reason">,
): RowAddress {
  if (!info.editable || info.key.length === 0)
    return { ok: false, reason: notEditableText(info.reason) };
  const key: KeyValue[] = [];
  for (const name of info.key) {
    const index = columns.findIndex((c) => c.name === name);
    const column = columns[index];
    const cell = row[index];
    if (!column || !cell) {
      return {
        ok: false,
        reason: "A column of this table's key is not shown, so this row cannot be found safely.",
      };
    }
    if (column.masked)
      return { ok: false, reason: "A column of the key is hidden. Show it to edit this row." };
    if (cell.truncated || cell.value === null) {
      return {
        ok: false,
        reason: "This row's key is too long to use, so the row cannot be edited here.",
      };
    }
    key.push({ column: name, value: cell.value });
  }
  return { ok: true, key };
}

// ------------------------------------------------------- building changes ---

/** One field of the row editor: what the person saw, and what they want now (`null`: SQL NULL). */
export interface FieldEdit {
  column: string;
  original: string | null;
  next: string | null;
}

export function changedFields(fields: readonly FieldEdit[]): FieldEdit[] {
  return fields.filter((f) => f.next !== f.original);
}

/** The update for the fields that changed, or null when nothing did. */
export function buildUpdate(
  table: TableRef,
  key: KeyValue[],
  fields: readonly FieldEdit[],
): UpdateRowChange | null {
  const changed = changedFields(fields);
  if (changed.length === 0) return null;
  return {
    kind: "update_row",
    table: { schema: table.schema, name: table.name },
    key: key.map((k) => ({ column: k.column, value: k.value })),
    set: changed.map((f) => ({ column: f.column, value: f.next })),
    expected: changed.map((f) => ({ column: f.column, value: f.original })),
  };
}

export function buildDelete(table: TableRef, key: KeyValue[]): DeleteRowChange {
  return {
    kind: "delete_row",
    table: { schema: table.schema, name: table.name },
    key: key.map((k) => ({ column: k.column, value: k.value })),
  };
}

/** For each column of a new row: leave it to the database's default, NULL, or a typed value. */
export type InsertMode = "default" | "null" | "value";

export interface InsertField {
  column: string;
  mode: InsertMode;
  value: string;
}

/** Can the database fill this column without a value from the person (a default, an identity, or NULL)? */
function fillsItself(column: EditableColumn): boolean {
  return column.generated || column.identity !== null || column.hasDefault;
}

/** What a column of a new row starts as. A mode the form does not offer is never the start. */
export function initialInsertMode(column: EditableColumn): InsertMode {
  return insertModes(column)[0] ?? "default";
}

/**
 * The modes a column of a new row offers, the first being where it starts.
 * - A column the database fills, or one whose type cannot be edited here (bytea:
 *   the planner refuses every value, NULL included), offers only its default.
 * - A column that may be NULL offers default, NULL and a value.
 * - A required column offers "default" only when it has a default or an
 *   identity; otherwise omitting it would fail, so it must be given a value.
 */
export function insertModes(column: EditableColumn): InsertMode[] {
  if (column.generated || !column.editable) return ["default"];
  if (column.nullable) return ["default", "null", "value"];
  return fillsItself(column) ? ["default", "value"] : ["value"];
}

export function buildInsert(table: TableRef, fields: readonly InsertField[]): InsertRowChange {
  return {
    kind: "insert_row",
    table: { schema: table.schema, name: table.name },
    values: fields
      .filter((f) => f.mode !== "default")
      .map((f) => ({ column: f.column, value: f.mode === "null" ? null : f.value })),
  };
}

// ---------------------------------------------------------- before / after ---

export type ShownValue =
  | { kind: "null" }
  | { kind: "value"; text: string; cut: boolean }
  | { kind: "default" }
  | { kind: "deleted" }
  | { kind: "none" };

export interface BeforeAfterRow {
  column: string;
  before: ShownValue;
  after: ShownValue;
}

const shown = (value: string | null, cut = false): ShownValue =>
  value === null ? { kind: "null" } : { kind: "value", text: value, cut };

export function updateBeforeAfter(fields: readonly FieldEdit[]): BeforeAfterRow[] {
  return changedFields(fields).map((f) => ({
    column: f.column,
    before: shown(f.original),
    after: shown(f.next),
  }));
}

export function insertBeforeAfter(fields: readonly InsertField[]): BeforeAfterRow[] {
  return fields.map((f) => ({
    column: f.column,
    before: { kind: "none" },
    after:
      f.mode === "default"
        ? { kind: "default" }
        : f.mode === "null"
          ? { kind: "null" }
          : shown(f.value),
  }));
}

/** The row as it was seen, every column marked as deleted. Hidden columns are left out. */
export function deleteBeforeAfter(
  columns: readonly Pick<RowColumn, "name" | "masked">[],
  row: readonly RowCell[],
): BeforeAfterRow[] {
  return columns.flatMap((column, index) => {
    const cell = row[index];
    if (!cell || column.masked) return [];
    return [
      {
        column: column.name,
        before: shown(cell.value, cell.truncated),
        after: { kind: "deleted" },
      },
    ];
  });
}

/** How a shown value reads in the before and after table. */
export function shownText(value: ShownValue): string {
  switch (value.kind) {
    case "null":
      return "NULL";
    case "value":
      return value.text === "" ? "(empty)" : value.cut ? `${value.text}…` : value.text;
    case "default":
      return "(default)";
    case "deleted":
      return "(deleted)";
    case "none":
      return "";
  }
}
