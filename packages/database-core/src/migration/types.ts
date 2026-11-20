/**
 * The plan of a migration (`docs/migration-studio-plan.md`, section 3.1): the steps that make one
 * structure look like another, in the order they must run, each with its reverse, its risk, and
 * whether it can run inside a transaction. A pure value: it is made from two structures and
 * options, with no connection and no clock, and it holds SQL as text that is never run here.
 */

/** What a step can cost or do. A step with no risk is safe. */
export type Risk =
  /** Takes a lock that blocks reads and writes of the table until it ends. */
  | "lock"
  /** Rewrites the whole table. */
  | "rewrite"
  /** Can fail on rows that exist (a NOT NULL, a constraint, a type conversion). */
  | "may_fail"
  /** Loses data or logic: a drop, or a conversion that rounds or cuts values. */
  | "destructive";

/** What the step's reverse brings back. */
export type Reversibility =
  /** The structure and everything in it. */
  | "full"
  /** The structure, but not the data that the step removed (or the reverse removes). */
  | "data_lost"
  /** Nothing: there is no reverse. */
  | "none";

export type StepKind =
  | "create_table"
  | "drop_table"
  | "comment_table"
  | "set_table_logging"
  | "set_table_options"
  | "add_column"
  | "drop_column"
  | "alter_column_type"
  | "set_not_null"
  | "drop_not_null"
  | "set_default"
  | "drop_default"
  | "add_identity"
  | "set_identity"
  | "drop_identity"
  | "comment_column"
  | "add_constraint"
  | "drop_constraint"
  | "validate_constraint"
  | "comment_constraint"
  | "create_index"
  | "drop_index"
  | "comment_index"
  | "create_schema"
  | "drop_schema"
  | "comment_schema"
  | "create_extension"
  | "drop_extension"
  | "update_extension"
  | "create_type"
  | "drop_type"
  | "alter_type"
  | "comment_type"
  | "create_sequence"
  | "drop_sequence"
  | "alter_sequence"
  | "own_sequence"
  | "comment_sequence"
  | "create_view"
  | "replace_view"
  | "drop_view"
  | "comment_view"
  | "create_function"
  | "replace_function"
  | "drop_function"
  | "comment_function"
  | "create_trigger"
  | "drop_trigger"
  | "alter_trigger"
  | "create_policy"
  | "alter_policy"
  | "drop_policy"
  | "row_security"
  | "rename_table"
  | "rename_column"
  | "rename_constraint"
  | "rename_index"
  | "rename_sequence";

/** What a step's object is, when it is not a table's own part. */
export type ObjectType =
  "schema" | "extension" | "type" | "sequence" | "view" | "function" | "trigger" | "policy";

/** What a step is about, for the screen and for grouping. */
export interface StepObject {
  schema: string;
  /** The table, or the relation (a view, for a trigger on one). Empty for a schema, type, sequence, function or extension. */
  table: string;
  /** What kind of object this is, when it is not a table or a table's own part. */
  of?: ObjectType;
  column?: string;
  /** The constraint or the index. */
  name?: string;
}

export interface MigrationStep {
  /** `s1`, `s2`, ...: in the order they run. */
  id: string;
  kind: StepKind;
  object: StepObject;
  /** SQL, each statement ending in a semicolon. */
  up: string;
  /** The reverse, or null when there is none. */
  down: string | null;
  risk: Risk[];
  reversibility: Reversibility;
  /** False for a statement PostgreSQL will not run inside a transaction (`CREATE INDEX CONCURRENTLY`). */
  transactional: boolean;
  /** Steps that must run first (their ids). */
  dependsOn: string[];
  /** One plain sentence for the screen and for the comment in the file. */
  note: string;
}

export interface MigrationPlan {
  steps: MigrationStep[];
  /** `full` when every step has a reverse that loses nothing; `none` when no step has one; else `partial`. */
  reversibility: "full" | "partial" | "none";
  /** Things the plan could not plan or did not look at, in plain sentences. Shown with every migration. */
  notCompared: string[];
  /** Things the plan noticed that need a person (a view that reads a column that goes, a sequence a default needs). */
  warnings: string[];
}

export interface PlanOptions {
  /** `CREATE INDEX CONCURRENTLY` for an index on a table that exists (a step outside the transaction). Default false. */
  concurrentIndexes?: boolean;
  /**
   * Add a CHECK or a foreign key to a table that exists as `NOT VALID`, then `VALIDATE CONSTRAINT`
   * in a step of its own: the long scan then holds a lighter lock. Default false.
   */
  safeConstraints?: boolean;
  /**
   * The ids of the renames a person confirmed (`suggestRenames`). A rename that is not here is a drop
   * and an add: the rows of a dropped table or column are gone. Default none.
   */
  renames?: string[];
}
