/**
 * Small, fixed pieces of SQL text for the write path: literals, the allow-list
 * of types, the structured defaults and the referential actions. Every piece
 * comes from a fixed table in this file or is a quoted name or literal; nothing
 * the person typed is ever pasted in as SQL.
 */
import {
  DatabaseError,
  IDENTITY_TYPES,
  LENGTH_TYPES,
  MAX_NUMERIC_PRECISION,
  MAX_TYPE_LENGTH,
  quoteIdentifier,
  quoteQualified,
  type ColumnDefault,
  type ColumnType,
  type ColumnTypeName,
  type ReferentialAction,
} from "@datacanvas/database-core";

/** An `invalid_change` with a sentence that names structure only. */
export function invalidChange(message: string): DatabaseError {
  return new DatabaseError("invalid_change", { message });
}

/**
 * Quote a string literal. Single quotes are doubled; a string that contains a
 * backslash becomes an `E''` literal with the backslashes doubled, so it means
 * the same whatever `standard_conforming_strings` is set to. A NUL character
 * cannot be stored in PostgreSQL text and is refused.
 */
export function quoteLiteral(value: string): string {
  if (value.includes("\0")) {
    throw invalidChange("A text value cannot contain a NUL character.");
  }
  const quoted = value.replace(/'/g, "''");
  return value.includes("\\") ? `E'${quoted.replace(/\\/g, "\\\\")}'` : `'${quoted}'`;
}

/** `schema.table` the way a person reads it (for sentences, not for SQL). */
export function displayName(schema: string, name: string): string {
  return `${schema}.${name}`;
}

/** How each allowed type is written in SQL. */
const TYPE_SQL: Record<ColumnTypeName, string> = {
  smallint: "smallint",
  integer: "integer",
  bigint: "bigint",
  numeric: "numeric",
  real: "real",
  "double precision": "double precision",
  boolean: "boolean",
  text: "text",
  varchar: "character varying",
  char: "character",
  date: "date",
  time: "time without time zone",
  timestamp: "timestamp without time zone",
  timestamptz: "timestamp with time zone",
  interval: "interval",
  uuid: "uuid",
  json: "json",
  jsonb: "jsonb",
  bytea: "bytea",
  inet: "inet",
};

const isWhole = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n);

/**
 * Look a request value up in one of the fixed tables of this file, by OWN key
 * only: `__proto__`, `constructor` or `toString` are not entries, whatever an
 * object inherits.
 */
function own<T>(table: Record<string, T>, key: unknown): T | undefined {
  return typeof key === "string" && Object.prototype.hasOwnProperty.call(table, key)
    ? table[key]
    : undefined;
}

/**
 * The SQL for a type from the allow-list, with its parameters checked again
 * here (the request schema already checked them; the adapter does not rely on it).
 */
export function renderType(type: ColumnType): string {
  const base = own(TYPE_SQL, type.name);
  if (base === undefined) throw invalidChange("This type is not offered.");
  let sql = base;
  if (type.length !== undefined) {
    if (!LENGTH_TYPES.includes(type.name))
      throw invalidChange("Only varchar and char take a length.");
    if (!isWhole(type.length) || type.length < 1 || type.length > MAX_TYPE_LENGTH) {
      throw invalidChange(`A length must be a whole number from 1 to ${MAX_TYPE_LENGTH}.`);
    }
    sql += `(${type.length})`;
  }
  if (type.precision !== undefined || type.scale !== undefined) {
    if (type.name !== "numeric") throw invalidChange("Only numeric takes a precision and a scale.");
    const { precision, scale } = type;
    if (!isWhole(precision) || precision < 1 || precision > MAX_NUMERIC_PRECISION) {
      throw invalidChange(`A precision must be a whole number from 1 to ${MAX_NUMERIC_PRECISION}.`);
    }
    if (scale !== undefined && (!isWhole(scale) || scale < 0 || scale > precision)) {
      throw invalidChange("A scale must be a whole number from 0 to the precision.");
    }
    sql += scale === undefined ? `(${precision})` : `(${precision},${scale})`;
  }
  return type.array ? `${sql}[]` : sql;
}

/** The type without its parameters, as `format_type(oid, NULL)` prints it. */
export function renderBaseType(type: ColumnType): string {
  const base = own(TYPE_SQL, type.name);
  if (base === undefined) throw invalidChange("This type is not offered.");
  return type.array ? `${base}[]` : base;
}

/** Can this type be an identity column? */
export function canBeIdentity(type: ColumnType): boolean {
  return IDENTITY_TYPES.includes(type.name) && type.array !== true;
}

/**
 * Which structured defaults fit which base types (as `format_type(oid, NULL)`
 * prints them). A literal fits every type: it is cast to it, and checked.
 */
const DEFAULT_FITS: Record<Exclude<ColumnDefault["kind"], "none" | "literal">, string[]> = {
  now: [
    "timestamp with time zone",
    "timestamp without time zone",
    "date",
    "time without time zone",
    "time with time zone",
  ],
  current_date: ["date", "timestamp with time zone", "timestamp without time zone"],
  gen_random_uuid: ["uuid"],
  boolean: ["boolean"],
};

export function defaultFits(kind: ColumnDefault["kind"], baseType: string): boolean {
  if (kind === "none" || kind === "literal") return true;
  return own(DEFAULT_FITS, kind)?.includes(baseType) ?? false;
}

/**
 * The SQL of a default for a column of type `typeSql` (the full type, so a
 * literal is cast to exactly it), or null for none. `uuidFunction` is the
 * qualified `gen_random_uuid` this server has, or null when it has none.
 */
export function renderDefault(
  value: ColumnDefault,
  typeSql: string,
  baseType: string,
  uuidFunction: string | null,
): string | null {
  if (!defaultFits(value.kind, baseType)) {
    throw invalidChange(`This kind of default does not fit a ${baseType} column.`);
  }
  switch (value.kind) {
    case "none":
      return null;
    case "literal":
      return `CAST(${quoteLiteral(value.value)} AS ${typeSql})`;
    case "now":
      return "now()";
    case "current_date":
      return "CURRENT_DATE";
    case "gen_random_uuid":
      if (uuidFunction === null) {
        throw invalidChange(
          "gen_random_uuid() is not available on this server (PostgreSQL 12 needs the pgcrypto extension).",
        );
      }
      return `${uuidFunction}()`;
    case "boolean":
      return value.value === true ? "true" : "false";
    default:
      throw invalidChange("This kind of default is not offered.");
  }
}

/** `"schema".gen_random_uuid` for the function this server has. */
export function qualifiedFunction(schema: string, name: string): string {
  return quoteQualified(schema, name);
}

const ACTION_SQL: Record<ReferentialAction, string> = {
  no_action: "NO ACTION",
  restrict: "RESTRICT",
  cascade: "CASCADE",
  set_null: "SET NULL",
  set_default: "SET DEFAULT",
};

/** The SQL of a referential action, from the fixed table only. */
export function renderAction(action: ReferentialAction): string {
  const sql = own(ACTION_SQL, action);
  if (sql === undefined) throw invalidChange("This foreign key action is not offered.");
  return sql;
}

/** What an ON DELETE action does to the rows that point at a deleted row, in plain words. */
export function onDeleteWords(action: ReferentialAction): string {
  switch (action) {
    case "no_action":
    case "restrict":
      return "the delete is refused while rows point at it";
    case "cascade":
      return "those rows are deleted too";
    case "set_null":
      return "those rows get NULL";
    case "set_default":
      return "those rows get their default";
  }
}

/** What an ON UPDATE action does when the key a row points at changes. */
export function onUpdateWords(action: ReferentialAction): string {
  switch (action) {
    case "no_action":
    case "restrict":
      return "the change is refused while rows point at the old key";
    case "cascade":
      return "those rows get the new key";
    case "set_null":
      return "those rows get NULL";
    case "set_default":
      return "those rows get their default";
  }
}

/** A comma-separated list of quoted column names. */
export function columnList(columns: readonly string[]): string {
  return columns.map(quoteIdentifier).join(", ");
}

/** Names listed for a person: `a, b and c`. */
export function listWords(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}
