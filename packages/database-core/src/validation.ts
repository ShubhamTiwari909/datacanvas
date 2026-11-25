/**
 * Validation: "would the database accept these values?", answered without writing a row
 * (`docs/advanced-data-workspace-plan.md`, section 6.2; decisions 154 and 157).
 *
 * The adapter checks the values in a TEMPORARY copy of the table that has no triggers, no foreign keys,
 * no defaults and no indexes, and asks about uniqueness and foreign keys with read-only queries on the
 * real tables. What comes back is a REPORT: which rule failed, on which column or constraint (names of
 * the structure), how many rows and the numbers of the first few. It never holds a value, so it can be
 * shown, and nothing in it can leak what a table contains.
 *
 * This file is the part both providers share: the request and its limits, the report, a collector that
 * builds it, and the fixed sentences that describe it. It talks to no database.
 */
import { DatabaseError } from "./errors.js";
import type { KeyValue } from "./changes.js";
import type { TableRef } from "./models.js";

/** The most rows in one validation: an import's, as many as one import takes (the request schema allows the same). */
export const VALIDATE_MAX_ROWS = 100_000;
/** The most columns in one validation (a function takes at most 100 arguments, and each column is one array). */
export const VALIDATE_MAX_COLUMNS = 50;
/** The most characters of one value. */
export const VALIDATE_MAX_VALUE_CHARS = 100_000;
/** Failing rows are searched for until this many are found; the report says when it stopped early. */
export const VALIDATE_MAX_FAILURES_FOUND = 100;
/** The row numbers listed for one rule. */
export const VALIDATE_ROWS_LISTED = 20;
/**
 * With `listAll` (an import that may leave out its failing rows, `docs/write-side-v2-plan.md` 4.3): failing
 * rows are searched for until MORE than this many are found, and each rule lists up to this many row numbers.
 * More failing rows than this: the report says `stopped_early` (the file needs fixing, it is not "a few bad rows").
 */
export const VALIDATE_LIST_ALL_MAX_FAILURES = 1000;
/**
 * With `listAll`, the whole validation's deadline (section 13.3 of the plan: 1,000 failing rows spread out
 * took 20 to 29 s, past the usual deadline of `statementTimeoutMs`). Never shorter than the usual one.
 */
export const VALIDATE_LIST_ALL_TIMEOUT_MS = 60_000;

/** The limits of one validation: the usual ones, or those of `listAll`. */
export interface ValidationLimits {
  /** The search for failing rows stops once this many different rows have failed. */
  stopAfter: number;
  /** The row numbers listed for one rule. */
  rowsListed: number;
  /** Says `stopped_early` when more rows than this failed (rows named, plus rows counted without naming). */
  mostListed: number | null;
}

export function validationLimits(request: Pick<ValidateRequest, "listAll">): ValidationLimits {
  return request.listAll === true
    ? {
        // One more than the limit: finding the 1,001st failing row is how "more than 1,000" is known.
        stopAfter: VALIDATE_LIST_ALL_MAX_FAILURES + 1,
        rowsListed: VALIDATE_LIST_ALL_MAX_FAILURES,
        mostListed: VALIDATE_LIST_ALL_MAX_FAILURES,
      }
    : {
        stopAfter: VALIDATE_MAX_FAILURES_FOUND,
        rowsListed: VALIDATE_ROWS_LISTED,
        mostListed: null,
      };
}

/**
 * What is asked.
 *  - `insert`: each row of `rows` would be added; `columns` are the columns given (the others are left to
 *    the database: a default, an identity, or NULL).
 *  - `update`: ONE row, found by `key`, would get `rows[0]` in `columns`; every other column keeps its value.
 */
export interface ValidateRequest {
  table: TableRef;
  mode: "insert" | "update";
  columns: string[];
  /** One list of values per row, each as long as `columns`; null is SQL NULL. Row numbers are 1-based positions here. */
  rows: Array<Array<string | null>>;
  /** For `update`: the key of the row. */
  key?: KeyValue[];
  /**
   * For `insert` only: list EVERY failing row, up to `VALIDATE_LIST_ALL_MAX_FAILURES`, with its own deadline
   * (`VALIDATE_LIST_ALL_TIMEOUT_MS`). The report keeps its shape: `issues[].rows` then names every failing
   * row (a row breaking two rules is in both), unless it says `stopped_early`: more rows failed than that.
   */
  listAll?: boolean;
  /**
   * For `insert` only: the rows will be an UPSERT keyed by these columns (`docs/write-side-v2-plan.md` 4.1,
   * 13.1 items 4 and 8). They must be exactly the columns of a primary key or unique constraint of the table
   * that can be a conflict target (not deferrable, every column NOT NULL), and all among `columns`; anything
   * else is `invalid_request`. Then a row matching an existing row by this key is an update, not a failure
   * (no `unique_existing` for this key), and for every other unique key a collision counts only with an
   * existing row OTHER than the one the file row would update. Repeated keys in the file are still
   * `unique_in_request`. Composes with `listAll`.
   */
  upsertKey?: string[];
}

export type ValidationRule =
  /** A column that may not be NULL is. */
  | "not_null"
  /** A CHECK constraint, or the check of a domain, said no. */
  | "check"
  /** A value does not fit its column's type (not a number, out of range, too long, not a date...). */
  | "type"
  /** Two rows of this request have the same value in a unique key. */
  | "unique_in_request"
  /** A row has a value that a row already in the table has, in a unique key. */
  | "unique_existing"
  /** A row points at a row that does not exist. */
  | "foreign_key"
  /** A rule of the table tried to change data while it was only being checked. */
  | "no_effects"
  /** The database refused the row for a reason this check does not name. */
  | "rejected";

export interface ValidationIssue {
  rule: ValidationRule;
  /** The column the rule is about, when the database or the check could name it. */
  column: string | null;
  /** The constraint or key, when there is one (structure, never a value). */
  constraint: string | null;
  /** How many rows break this rule (at least this many when the report says it stopped early). */
  count: number;
  /** The first `VALIDATE_ROWS_LISTED` row numbers (`VALIDATE_LIST_ALL_MAX_FAILURES` with `listAll`; 1-based, in the order of the request). */
  rows: number[];
}

/** What a validation does NOT check, for this table. Each is a fixed sentence (`NOTE_TEXT`). */
export type ValidationNote =
  /** The table has triggers: they run when the change is applied. */
  | "triggers"
  /** Row-level security applies to this role: it may hide or refuse a row that this check let through. */
  | "row_level_security"
  /** A unique index that is partial or built on an expression was not checked. */
  | "other_unique_indexes"
  /** A foreign key could not be checked: the referenced table cannot be read by this role. */
  | "foreign_key_unreadable"
  /** The search for failing rows stopped after `VALIDATE_MAX_FAILURES_FOUND` (with `listAll`: more than `VALIDATE_LIST_ALL_MAX_FAILURES` rows failed). */
  | "stopped_early"
  /** A rule (a CHECK over several columns, a unique key or a foreign key) was judged without the defaults of the columns the row did not give. */
  | "defaults_not_applied"
  /** The table has an exclusion constraint, which the copy does not carry. */
  | "exclusion_constraints"
  /** The table is partitioned (or is a partition): the bounds of the partitions are not checked. */
  | "partition_bounds"
  /** An event trigger exists in this database: it runs when the temporary copy is made. */
  | "event_triggers"
  /** A unique key or foreign key on a column whose name looks sensitive was not checked (it would answer "does this value exist?"). */
  | "hidden_columns";

export interface ValidationReport {
  /** How many rows were asked about. */
  rows: number;
  /** How many of them broke no rule that was checked. */
  passed: number;
  issues: ValidationIssue[];
  notChecked: ValidationNote[];
}

const invalid = () => new DatabaseError("invalid_request");

/**
 * Check the shape of a request. A request that does not fit is `invalid_request` (a fixed message,
 * no echo): the names are checked against the catalog by the adapter.
 */
export function checkValidateRequest(request: ValidateRequest): void {
  const { mode, columns, rows } = request;
  if (mode !== "insert" && mode !== "update") throw invalid();
  if (columns.length > VALIDATE_MAX_COLUMNS) throw invalid();
  if (new Set(columns).size !== columns.length) throw invalid();
  if (rows.length < 1 || rows.length > VALIDATE_MAX_ROWS) throw invalid();
  for (const row of rows) {
    if (row.length !== columns.length) throw invalid();
    for (const value of row) {
      if (
        value !== null &&
        (typeof value !== "string" || value.length > VALIDATE_MAX_VALUE_CHARS)
      ) {
        throw invalid();
      }
    }
  }
  if (request.listAll !== undefined && typeof request.listAll !== "boolean") throw invalid();
  const upsertKey: unknown = request.upsertKey;
  if (upsertKey !== undefined) {
    if (!Array.isArray(upsertKey) || upsertKey.length < 1 || upsertKey.length > 32) throw invalid();
    if (!upsertKey.every((c) => typeof c === "string")) throw invalid();
    if (new Set(upsertKey).size !== upsertKey.length) throw invalid();
    // Every column of the key is given by the file: the key is what finds the row to update.
    if (!upsertKey.every((c: string) => columns.includes(c))) throw invalid();
  }
  if (mode === "update") {
    // Listing every failing row, and an upsert, are for an import; an update checks one row.
    if (request.listAll !== undefined) throw invalid();
    if (upsertKey !== undefined) throw invalid();
    if (rows.length !== 1 || columns.length < 1) throw invalid();
    const key = request.key;
    if (!key || key.length < 1 || key.length > 32) throw invalid();
    if (new Set(key.map((k) => k.column)).size !== key.length) throw invalid();
  } else if (request.key !== undefined) {
    throw invalid();
  }
}

/** Builds the report's issues from failures, one row at a time. */
export class IssueCollector {
  private readonly byKey = new Map<string, ValidationIssue>();
  private readonly failed = new Set<number>();
  /** Rows a query counted but did not list: they may be rows no other rule named. */
  private unseen = 0;

  /** @param rowsListed the row numbers listed for one rule (`validationLimits(request).rowsListed`). */
  constructor(private readonly rowsListed: number = VALIDATE_ROWS_LISTED) {}

  add(rule: ValidationRule, column: string | null, constraint: string | null, row: number): void {
    const key = JSON.stringify([rule, column, constraint]);
    let issue = this.byKey.get(key);
    if (!issue) {
      issue = { rule, column, constraint, count: 0, rows: [] };
      this.byKey.set(key, issue);
    }
    issue.count += 1;
    if (issue.rows.length < this.rowsListed) issue.rows.push(row);
    this.failed.add(row);
  }

  /** Add many rows of one rule at once (a count and the first rows, from a query). */
  addMany(
    rule: ValidationRule,
    column: string | null,
    constraint: string | null,
    count: number,
    rows: readonly number[],
  ): void {
    if (count <= 0) return;
    this.unseen += Math.max(0, count - rows.length);
    const key = JSON.stringify([rule, column, constraint]);
    let issue = this.byKey.get(key);
    if (!issue) {
      issue = { rule, column, constraint, count: 0, rows: [] };
      this.byKey.set(key, issue);
    }
    issue.count += count;
    for (const row of rows) {
      if (issue.rows.length < this.rowsListed && !issue.rows.includes(row)) issue.rows.push(row);
      this.failed.add(row);
    }
  }

  /** The most rows that can have failed: the rows named, plus every row a query counted without naming. */
  get mostFailedRows(): number {
    return this.failed.size + this.unseen;
  }

  /** The most rows any one issue counts. */
  get largestCount(): number {
    let most = 0;
    for (const issue of this.byKey.values()) most = Math.max(most, issue.count);
    return most;
  }

  /** How many different rows failed so far. */
  get failedRows(): number {
    return this.failed.size;
  }

  issues(): ValidationIssue[] {
    return [...this.byKey.values()]
      .map((i) => ({ ...i, rows: [...i.rows].sort((a, b) => a - b) }))
      .sort((a, b) => (a.rows[0] ?? 0) - (b.rows[0] ?? 0) || a.rule.localeCompare(b.rule));
  }
}

export function buildReport(
  rows: number,
  collector: IssueCollector,
  notChecked: readonly ValidationNote[],
): ValidationReport {
  return {
    rows,
    // A query lists only the first rows it found. The rows it counted without naming may be rows no other rule
    // named, so they are all counted as failed: `passed` is a lower bound (and the screen says "at least" then).
    passed: Math.max(0, rows - collector.mostFailedRows),
    issues: collector.issues(),
    notChecked: [...new Set(notChecked)],
  };
}

// ------------------------------------------------------------------ words ---

const quote = (name: string) => `"${name}"`;

/** One sentence for an issue, from fixed words and the names of the structure. Never a value. */
export function describeIssue(issue: ValidationIssue): string {
  const col = issue.column ? ` in ${quote(issue.column)}` : "";
  const con = issue.constraint ? ` ${quote(issue.constraint)}` : "";
  switch (issue.rule) {
    case "not_null":
      return `${issue.column ? quote(issue.column) : "A column"} cannot be NULL.`;
    case "check":
      return `The rule${con} of the table or of a column type is not met.`;
    case "type":
      return issue.column
        ? `The value${col} does not fit the column: its type, its length or its range.`
        : "A value does not fit its column: its type, its length or its range.";
    case "unique_in_request":
      return `Two rows have the same value${con ? ` for${con}` : " for a unique key"}.`;
    case "unique_existing":
      return `A row with this value already exists${con ? ` for${con}` : " for a unique key"}.`;
    case "foreign_key":
      return `The row refers to a row that does not exist${con ? ` (${con.trim()})` : ""}.`;
    case "no_effects":
      return "A rule of this table tried to change data, which a check does not allow, so it could not be checked.";
    case "rejected":
      return `The database would refuse this row${con ? ` (${con.trim()})` : ""}.`;
  }
}

export const NOTE_TEXT: Record<ValidationNote, string> = {
  triggers:
    "This table has triggers. They run when the change is applied and are not part of this check.",
  row_level_security:
    "Row-level security applies to this role. It may refuse or hide a row that this check accepted.",
  other_unique_indexes: "A unique index that is partial or built on an expression was not checked.",
  foreign_key_unreadable:
    "A foreign key was not checked, because this role cannot read the table it points to.",
  stopped_early: "The search for failing rows stopped early, so there may be more than are listed.",
  defaults_not_applied:
    "A rule of this table (a check, a unique key or a foreign key) reads a column that was not given. That column takes its default only when the change is applied, so the rule may be judged differently then, or was not checked.",
  exclusion_constraints:
    "This table has an exclusion constraint. It was not checked, and it can refuse a row that this check accepted.",
  partition_bounds:
    "This table is partitioned, or is a partition. The bounds of the partitions were not checked: a row that fits none of them is refused when the change is applied.",
  event_triggers:
    "This database has an event trigger. It runs when the temporary copy is made, and what it does outside the transaction is not undone.",
  hidden_columns:
    "A unique key or foreign key on a column whose name looks sensitive was not checked, because the answer would tell whether a value exists in it.",
};
