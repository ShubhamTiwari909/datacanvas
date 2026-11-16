/**
 * The rules of the table builder, as pure functions: how a column's type and
 * default read, which defaults a type offers, turning the builder's form into a
 * `create_table` change, and the quick checks shown while typing. The server
 * checks everything again against the catalog; these only spare a round trip.
 */
import {
  COLUMN_TYPE_NAMES,
  IDENTITY_TYPES,
  LENGTH_TYPES,
  MAX_COMMENT_CHARS,
  isValidNewIdentifier,
  type Change,
  type ColumnDefault,
  type ColumnDefinition,
  type ColumnType,
  type ColumnTypeName,
  type CreateTableChange,
  type ForeignKeyDefinition,
  type IdentityKind,
  type ReferentialAction,
} from "@datacanvas/database-core";

export { COLUMN_TYPE_NAMES };

/** `varchar(255)`, `numeric(10,2)[]`, `timestamptz`. */
export function formatColumnType(type: ColumnType): string {
  let text: string = type.name;
  if (type.length !== undefined) text += `(${type.length})`;
  if (type.precision !== undefined) {
    text += type.scale !== undefined ? `(${type.precision},${type.scale})` : `(${type.precision})`;
  }
  return type.array ? `${text}[]` : text;
}

export function takesLength(name: ColumnTypeName): boolean {
  return LENGTH_TYPES.includes(name);
}

export function canBeIdentity(type: ColumnType): boolean {
  return IDENTITY_TYPES.includes(type.name) && !type.array;
}

export type DefaultKind = ColumnDefault["kind"];

export const DEFAULT_LABEL: Record<DefaultKind, string> = {
  none: "No default",
  literal: "A value",
  now: "now() (the current time)",
  current_date: "current_date (today)",
  gen_random_uuid: "gen_random_uuid() (a new UUID)",
  boolean: "true or false",
};

/** The default kinds that make sense for a type. */
export function defaultKindsFor(type: ColumnType): DefaultKind[] {
  const kinds: DefaultKind[] = ["none", "literal"];
  if (type.array) return kinds;
  if (type.name === "timestamp" || type.name === "timestamptz") kinds.push("now", "current_date");
  if (type.name === "date") kinds.push("current_date", "now");
  if (type.name === "uuid") kinds.push("gen_random_uuid");
  if (type.name === "boolean") kinds.push("boolean");
  return kinds;
}

export function describeDefault(value: ColumnDefault): string {
  switch (value.kind) {
    case "none":
      return "no default";
    case "literal":
      return value.value === "" ? "an empty value" : `the value ${value.value}`;
    case "now":
      return "now()";
    case "current_date":
      return "current_date";
    case "gen_random_uuid":
      return "gen_random_uuid()";
    case "boolean":
      return value.value ? "true" : "false";
  }
}

export const ACTION_LABEL: Record<ReferentialAction, string> = {
  no_action: "No action",
  restrict: "Restrict",
  cascade: "Cascade",
  set_null: "Set NULL",
  set_default: "Set default",
};

export const ACTIONS: ReferentialAction[] = [
  "no_action",
  "restrict",
  "cascade",
  "set_null",
  "set_default",
];

// ------------------------------------------------------------ form states ---

/** One column in the builder's form; numbers are text while being typed. */
export interface ColumnForm {
  /** A stable id for React keys (the name changes while typing). */
  id: string;
  name: string;
  typeName: ColumnTypeName;
  length: string;
  precision: string;
  scale: string;
  array: boolean;
  nullable: boolean;
  defaultKind: DefaultKind;
  defaultValue: string;
  defaultBoolean: boolean;
  identity: IdentityKind | null;
  comment: string;
}

let counter = 0;
export function newColumnForm(overrides: Partial<ColumnForm> = {}): ColumnForm {
  counter += 1;
  return {
    id: `col-${counter}`,
    name: "",
    typeName: "text",
    length: "",
    precision: "",
    scale: "",
    array: false,
    nullable: true,
    defaultKind: "none",
    defaultValue: "",
    defaultBoolean: false,
    identity: null,
    comment: "",
    ...overrides,
  };
}

const whole = (text: string): number | undefined =>
  /^\d+$/.test(text.trim()) ? Number(text.trim()) : undefined;

export function columnTypeOf(form: ColumnForm): ColumnType {
  const type: ColumnType = { name: form.typeName };
  if (takesLength(form.typeName)) {
    const length = whole(form.length);
    if (length !== undefined) type.length = length;
  }
  if (form.typeName === "numeric") {
    const precision = whole(form.precision);
    const scale = whole(form.scale);
    if (precision !== undefined) type.precision = precision;
    if (precision !== undefined && scale !== undefined) type.scale = scale;
  }
  if (form.array) type.array = true;
  return type;
}

export function columnDefaultOf(form: ColumnForm): ColumnDefault {
  switch (form.defaultKind) {
    case "literal":
      return { kind: "literal", value: form.defaultValue };
    case "boolean":
      return { kind: "boolean", value: form.defaultBoolean };
    case "none":
    case "now":
    case "current_date":
    case "gen_random_uuid":
      return { kind: form.defaultKind };
  }
}

export function columnDefinitionOf(form: ColumnForm): ColumnDefinition {
  const type = columnTypeOf(form);
  const identity = form.identity !== null && canBeIdentity(type) ? form.identity : null;
  return {
    name: form.name,
    type,
    // An identity column is never NULL.
    nullable: identity === null ? form.nullable : false,
    default: identity === null ? columnDefaultOf(form) : { kind: "none" },
    identity,
    comment: form.comment.trim() === "" ? null : form.comment,
  };
}

/** Problems with one column, as sentences that never repeat what was typed. */
export function columnProblems(form: ColumnForm): string[] {
  const problems: string[] = [];
  if (form.name === "") problems.push("A column needs a name.");
  else if (!isValidNewIdentifier(form.name))
    problems.push("A column name can be at most 63 bytes and cannot start or end with a space.");
  if (takesLength(form.typeName) && form.length.trim() !== "" && whole(form.length) === undefined)
    problems.push("The length must be a whole number.");
  if (form.typeName === "char" && form.length.trim() === "") problems.push("char needs a length.");
  if (form.typeName === "numeric") {
    const precision = whole(form.precision);
    const scale = whole(form.scale);
    if (form.precision.trim() !== "" && precision === undefined)
      problems.push("The precision must be a whole number.");
    if (form.scale.trim() !== "" && precision === undefined)
      problems.push("A scale needs a precision.");
    if (precision !== undefined && scale !== undefined && scale > precision)
      problems.push("The scale cannot be larger than the precision.");
  }
  if (form.identity !== null && !canBeIdentity(columnTypeOf(form)))
    problems.push("Only smallint, integer and bigint can be an identity column.");
  if (form.comment.length > MAX_COMMENT_CHARS) problems.push("The comment is too long.");
  return problems;
}

/** A unique constraint or primary key, as the builder holds it. */
export type ColumnSet = string[];

export interface ForeignKeyForm {
  id: string;
  columns: string[];
  schema: string;
  table: string;
  referenced: string[];
  onDelete: ReferentialAction;
  onUpdate: ReferentialAction;
}

export function newForeignKeyForm(schema: string): ForeignKeyForm {
  counter += 1;
  return {
    id: `fk-${counter}`,
    columns: [""],
    schema,
    table: "",
    referenced: [""],
    onDelete: "no_action",
    onUpdate: "no_action",
  };
}

export function foreignKeyOf(form: ForeignKeyForm): ForeignKeyDefinition {
  return {
    columns: form.columns,
    references: { schema: form.schema, table: form.table, columns: form.referenced },
    onDelete: form.onDelete,
    onUpdate: form.onUpdate,
  };
}

export interface CreateTableForm {
  schema: string;
  name: string;
  columns: ColumnForm[];
  primaryKey: string[];
  unique: ColumnSet[];
  foreignKeys: ForeignKeyForm[];
  comment: string;
}

export function buildCreateTable(form: CreateTableForm): CreateTableChange {
  return {
    kind: "create_table",
    schema: form.schema,
    name: form.name,
    columns: form.columns.map(columnDefinitionOf),
    primaryKey: form.primaryKey,
    unique: form.unique.filter((set) => set.length > 0),
    foreignKeys: form.foreignKeys.map(foreignKeyOf),
    comment: form.comment.trim() === "" ? null : form.comment,
  };
}

/** Everything wrong with the builder's form, or an empty list when it can be previewed. */
export function createTableProblems(form: CreateTableForm): string[] {
  const problems: string[] = [];
  if (form.name === "") problems.push("The table needs a name.");
  else if (!isValidNewIdentifier(form.name))
    problems.push("A table name can be at most 63 bytes and cannot start or end with a space.");
  if (form.columns.length === 0) problems.push("A table needs at least one column.");
  form.columns.forEach((column, index) => {
    for (const problem of columnProblems(column)) problems.push(`Column ${index + 1}: ${problem}`);
  });
  const names = form.columns.map((c) => c.name).filter((n) => n !== "");
  if (new Set(names).size !== names.length) problems.push("Two columns have the same name.");
  const known = new Set(names);
  if (form.primaryKey.some((name) => !known.has(name)))
    problems.push("The primary key names a column that is not in the table.");
  form.unique.forEach((set, index) => {
    if (set.some((name) => !known.has(name)))
      problems.push(`Unique constraint ${index + 1} names a column that is not in the table.`);
  });
  form.foreignKeys.forEach((fk, index) => {
    const label = `Foreign key ${index + 1}`;
    if (fk.columns.some((c) => c === "" || !known.has(c)))
      problems.push(`${label}: choose columns of this table.`);
    if (fk.table === "") problems.push(`${label}: choose the table it points at.`);
    if (fk.referenced.some((c) => c === ""))
      problems.push(`${label}: choose the columns it points at.`);
    if (fk.columns.length !== fk.referenced.length)
      problems.push(`${label}: it needs as many referenced columns as columns.`);
  });
  if (form.comment.length > MAX_COMMENT_CHARS) problems.push("The table comment is too long.");
  return problems;
}

// ------------------------------------------------------------- the labels ---

export const CHANGE_LABEL: Record<Change["kind"], string> = {
  update_row: "Edit row",
  insert_row: "Add row",
  delete_row: "Delete row",
  create_table: "Create table",
  add_column: "Add column",
  rename_column: "Rename column",
  rename_table: "Rename table",
  alter_column_type: "Change column type",
  set_nullable: "Change NOT NULL",
  set_default: "Change default",
  add_primary_key: "Add primary key",
  add_unique: "Add unique constraint",
  add_foreign_key: "Add foreign key",
  drop_constraint: "Drop constraint",
  create_index: "Create index",
  drop_index: "Drop index",
  drop_column: "Drop column",
  drop_table: "Drop table",
};

/** The label of a history entry's kind (the server may know kinds this page does not). */
export function changeLabel(kind: string): string {
  return (CHANGE_LABEL as Record<string, string>)[kind] ?? kind;
}
