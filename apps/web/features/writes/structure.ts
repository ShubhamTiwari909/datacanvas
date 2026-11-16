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
  MAX_NUMERIC_PRECISION,
  MAX_TYPE_LENGTH,
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

/**
 * The default kinds an EXISTING column offers, from the type as the database
 * prints it (`format_type`: "integer", "timestamp(3) with time zone", "uuid",
 * "text[]"). Used by "Set default", where the column is chosen from the table
 * rather than typed in a form. With no column chosen yet only the kinds that suit
 * every type are offered.
 */
export function defaultKindsForDataType(dataType: string | undefined): DefaultKind[] {
  if (dataType === undefined) return ["none", "literal"];
  const text = dataType.trim().toLowerCase();
  const array = text.endsWith("[]");
  const base = text.replace(/\[\]$/, "").replace(/\(.*?\)/g, "");
  let name: ColumnTypeName | "other" = "other";
  if (/^timestamp\b.*with time zone$/.test(base)) name = "timestamptz";
  else if (/^timestamp\b/.test(base)) name = "timestamp";
  else if (base === "date") name = "date";
  else if (base === "uuid") name = "uuid";
  else if (base === "boolean") name = "boolean";
  if (array || name === "other") return ["none", "literal"];
  return defaultKindsFor({ name });
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

/**
 * The form with its default put back to "none" when its type does not offer the
 * kind it holds (a type change from timestamp to integer must not keep `now()`).
 */
export function withSupportedDefault(form: ColumnForm): ColumnForm {
  return defaultKindsFor(columnTypeOf(form)).includes(form.defaultKind)
    ? form
    : { ...form, defaultKind: "none" };
}

/**
 * What to change in a column's form for an edit: the edit itself, plus resetting
 * the default when the edit made the type unable to carry it.
 */
export function columnFormPatch(form: ColumnForm, next: Partial<ColumnForm>): Partial<ColumnForm> {
  const merged = withSupportedDefault({ ...form, ...next });
  return merged.defaultKind === (next.defaultKind ?? form.defaultKind)
    ? next
    : { ...next, defaultKind: merged.defaultKind };
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
    // A default the type does not offer is never sent (it would only be refused).
    default: identity === null ? columnDefaultOf(withSupportedDefault(form)) : { kind: "none" },
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
  if (takesLength(form.typeName) && form.length.trim() !== "") {
    const length = whole(form.length);
    if (length === undefined) problems.push("The length must be a whole number.");
    else if (length < 1 || length > MAX_TYPE_LENGTH)
      problems.push(`The length must be between 1 and ${MAX_TYPE_LENGTH}.`);
  }
  if (form.typeName === "char" && form.length.trim() === "") problems.push("char needs a length.");
  if (form.typeName === "numeric") {
    const precision = whole(form.precision);
    const scale = whole(form.scale);
    if (form.precision.trim() !== "" && precision === undefined)
      problems.push("The precision must be a whole number.");
    else if (precision !== undefined && (precision < 1 || precision > MAX_NUMERIC_PRECISION))
      problems.push(`The precision must be between 1 and ${MAX_NUMERIC_PRECISION}.`);
    if (form.scale.trim() !== "" && scale === undefined)
      problems.push("The scale must be a whole number.");
    else if (scale !== undefined && scale > MAX_NUMERIC_PRECISION)
      problems.push(`The scale must be between 0 and ${MAX_NUMERIC_PRECISION}.`);
    if (form.scale.trim() !== "" && form.precision.trim() === "")
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

/**
 * What is wrong with one foreign key's choices, without the `Foreign key N:`
 * prefix. `knownColumns` is the columns of the table that holds the key.
 */
export function foreignKeyProblems(
  fk: Pick<ForeignKeyForm, "columns" | "table" | "referenced">,
  knownColumns: ReadonlySet<string>,
): string[] {
  const problems: string[] = [];
  if (fk.columns.some((c) => c === "" || !knownColumns.has(c)))
    problems.push("choose columns of this table.");
  if (fk.table === "") problems.push("choose the table it points at.");
  if (fk.referenced.some((c) => c === "")) problems.push("choose the columns it points at.");
  if (fk.columns.length !== fk.referenced.length)
    problems.push("it needs as many referenced columns as columns.");
  const repeats = (list: string[]) => {
    const chosen = list.filter((c) => c !== "");
    return new Set(chosen).size !== chosen.length;
  };
  if (repeats(fk.columns)) problems.push("a column of this table is chosen twice.");
  if (repeats(fk.referenced)) problems.push("a referenced column is chosen twice.");
  return problems;
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
    for (const problem of foreignKeyProblems(fk, known))
      problems.push(`Foreign key ${index + 1}: ${problem}`);
  });
  if (form.comment.length > MAX_COMMENT_CHARS) problems.push("The table comment is too long.");
  return problems;
}

// ------------------------------------------- keeping the form consistent ---

const mapNames = (list: string[], from: string, to: string) =>
  list.map((name) => (name === from ? to : name));

/**
 * Rename a column (by its stable id), and everything in the form that holds its
 * name: the primary key, the unique constraints and the columns of foreign keys.
 * Nothing is left pointing at a name that no longer exists.
 */
export function renameColumnIn(form: CreateTableForm, id: string, to: string): CreateTableForm {
  const from = form.columns.find((c) => c.id === id)?.name;
  if (from === undefined || from === to) return form;
  // A key or unique set holds a blank only for a column whose name was cleared while typing, so
  // it follows the column when the name comes back. A foreign key's blank means "not chosen yet"
  // and must not be filled in by a rename.
  const renameFk = (list: string[]) => (from === "" ? list : mapNames(list, from, to));
  return {
    ...form,
    columns: form.columns.map((c) => (c.id === id ? { ...c, name: to } : c)),
    primaryKey: mapNames(form.primaryKey, from, to),
    unique: form.unique.map((set) => mapNames(set, from, to)),
    foreignKeys: form.foreignKeys.map((fk) => ({ ...fk, columns: renameFk(fk.columns) })),
  };
}

/**
 * Remove a column (by its stable id), and every use of its name: the primary
 * key, the unique constraints, and the foreign key pairs that start at it. A
 * foreign key left with no pair keeps one blank pair, so its row stays on
 * screen and says what to choose.
 */
export function removeColumnIn(form: CreateTableForm, id: string): CreateTableForm {
  const removed = form.columns.find((c) => c.id === id);
  if (!removed) return form;
  const name = removed.name;
  const without = (list: string[]) => (name === "" ? list : list.filter((n) => n !== name));
  return {
    ...form,
    columns: form.columns.filter((c) => c.id !== id),
    primaryKey: without(form.primaryKey),
    unique: form.unique.map(without),
    foreignKeys: form.foreignKeys.map((fk) => {
      if (name === "" || !fk.columns.includes(name)) return fk;
      const keep = fk.columns.map((c) => c !== name);
      const columns = fk.columns.filter((_, i) => keep[i]);
      const referenced = fk.referenced.filter((_, i) => keep[i]);
      return columns.length > 0
        ? { ...fk, columns, referenced }
        : { ...fk, columns: [""], referenced: [""] };
    }),
  };
}

/**
 * Rename the new table, and move a foreign key that points at the table itself
 * with it. Otherwise the key would keep naming the old name and could silently
 * point at an existing table of that name.
 */
export function renameTableIn(form: CreateTableForm, to: string): CreateTableForm {
  if (form.name === to) return form;
  return {
    ...form,
    name: to,
    foreignKeys:
      form.name === ""
        ? form.foreignKeys
        : form.foreignKeys.map((fk) =>
            fk.schema === form.schema && fk.table === form.name ? { ...fk, table: to } : fk,
          ),
  };
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
