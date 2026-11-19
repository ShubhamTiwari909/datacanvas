/**
 * What a migration needs to know that the structure of 1.0 to 1.6 did not record
 * (`docs/migration-studio-plan.md`, section 6): the parts of a definition that `CREATE` and
 * `ALTER` statements have to say and that a name, a type and a default do not.
 *
 * It is SPARSE: a list holds only what is not the default (a column that is identity, generated
 * or has its own collation; a constraint that is deferrable or not yet validated; a table that is
 * partitioned, inherits, is unlogged or has storage options), so an ordinary database adds a few
 * lines, not a line per column. A structure that never recorded this has `ddl: null`, which is
 * not the same as having none: the planner says which parts it could not plan, as the comparison
 * does for objects.
 *
 * Names only and settings; no row is read.
 */
import type { IdentityKind } from "./changes.js";
import { compareText } from "./structure.js";

export type GeneratedKind = "stored" | "virtual";

/** A column that is identity, generated or has a collation other than its type's default. */
export interface ColumnDdl {
  schema: string;
  table: string;
  column: string;
  identity: IdentityKind | null;
  /** The expression itself is the column's `defaultValue`. */
  generated: GeneratedKind | null;
  /** The collation (`"C"`, `"en_US"`), as the database names it, when it is not the type's default. */
  collation: string | null;
}

/** A constraint that is deferrable, was added without being checked, or has a foreign key match type. */
export interface ConstraintDdl {
  schema: string;
  table: string;
  name: string;
  deferrable: boolean;
  initiallyDeferred: boolean;
  /** False for a constraint added `NOT VALID`: existing rows were not checked. */
  validated: boolean;
  /** A foreign key's `MATCH` type when it is not the default (`simple`). */
  match: "full" | "partial" | null;
}

/** A table that is partitioned, a partition, inherits, is unlogged, or has storage options or a tablespace. */
export interface TableDdl {
  schema: string;
  name: string;
  unlogged: boolean;
  /** `PARTITION BY RANGE (created_at)`'s part after `BY`, as `pg_get_partkeydef` prints it, for a partitioned table. */
  partitionKey: string | null;
  /** For a partition: its parent and its bound (`FOR VALUES FROM ('2026-01-01') TO ('2027-01-01')`). */
  partitionOf: { schema: string; table: string; bound: string } | null;
  /** Tables it inherits from (not counting a partition's parent), in order. */
  inherits: { schema: string; table: string }[];
  /** `fillfactor=70` and the like, as the database prints them. */
  options: string[];
  tablespace: string | null;
}

export type CommentTarget = "schema" | "index" | "constraint" | "type" | "sequence";

/** A comment on something whose comment the structure does not carry already (tables, columns and functions do). */
export interface ObjectComment {
  target: CommentTarget;
  schema: string;
  /** The table of an index or a constraint. */
  table: string | null;
  name: string;
  comment: string;
}

export interface DdlDetail {
  /** `server_version_num`, e.g. 160004: the syntax a migration uses depends on it. */
  serverVersion: number;
  columns: ColumnDdl[];
  constraints: ConstraintDdl[];
  tables: TableDdl[];
  comments: ObjectComment[];
}

export const emptyDdl = (serverVersion: number): DdlDetail => ({
  serverVersion,
  columns: [],
  constraints: [],
  tables: [],
  comments: [],
});

const col = (c: { schema: string; table: string }) => `${c.schema}.${c.table}`;

/** Order everything, so the same database always gives the same value. */
export function normalizeDdl(ddl: DdlDetail): DdlDetail {
  const by = <T>(list: readonly T[], key: (item: T) => string): T[] =>
    [...list].sort((a, b) => compareText(key(a), key(b)));
  return {
    serverVersion: ddl.serverVersion,
    columns: by(ddl.columns, (c) => `${col(c)}.${c.column}`),
    constraints: by(ddl.constraints, (c) => `${col(c)}.${c.name}`),
    tables: by(ddl.tables, (t) => `${t.schema}.${t.name}`),
    comments: by(ddl.comments, (c) => `${c.target}.${c.schema}.${c.table ?? ""}.${c.name}`),
  };
}

/**
 * The differences between two details, as readable lines (empty when they match). The server
 * version is not a difference: two databases can be on different versions and have the same shape.
 * Used by the migration tests as part of the oracle: after a migration, nothing may differ.
 */
export function ddlDifferences(before: DdlDetail, after: DdlDetail): string[] {
  const a = normalizeDdl(before);
  const b = normalizeDdl(after);
  const out: string[] = [];
  const compare = <T>(
    label: string,
    x: readonly T[],
    y: readonly T[],
    key: (item: T) => string,
  ) => {
    const left = new Map(x.map((item) => [key(item), JSON.stringify(item)]));
    const right = new Map(y.map((item) => [key(item), JSON.stringify(item)]));
    for (const [k, v] of left) {
      if (!right.has(k)) out.push(`${label} ${k}: only before (${v})`);
      else if (right.get(k) !== v) out.push(`${label} ${k}: ${v} -> ${right.get(k)}`);
    }
    for (const [k, v] of right) if (!left.has(k)) out.push(`${label} ${k}: only after (${v})`);
  };
  compare("column", a.columns, b.columns, (c) => `${col(c)}.${c.column}`);
  compare("constraint", a.constraints, b.constraints, (c) => `${col(c)}.${c.name}`);
  compare("table", a.tables, b.tables, (t) => `${t.schema}.${t.name}`);
  compare(
    "comment",
    a.comments,
    b.comments,
    (c) => `${c.target} ${c.schema}.${c.table ?? ""}.${c.name}`,
  );
  return out;
}
