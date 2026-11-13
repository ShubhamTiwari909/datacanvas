/**
 * Metadata models: the vocabulary DataCanvas uses to describe a database's
 * STRUCTURE (never its rows).
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
 * have columns like tables do, but no constraints of their own.
 */
export type RelationKind = "table" | "view" | "materialized_view";

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
