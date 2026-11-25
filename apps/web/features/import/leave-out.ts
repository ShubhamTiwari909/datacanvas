/**
 * Leaving out the rows of a file that fail the validation (`docs/write-side-v2-plan.md`, section 4.3, items 2 and 4).
 * The browser removes the failing rows from the matrix it holds and imports the rest as usual: nothing in the server
 * changes. Pure functions, no React.
 *
 * Row numbers. A validation report numbers rows 1, 2, 3... in the order of the rows it was SENT (the data rows,
 * below the header when there is one). After rows are left out the next request is shorter, so its numbers are
 * positions among the rows that remain. Every step here therefore carries, for each row, the file's LINE it came
 * from (`parseCsv`'s `lines`: blank lines and line breaks inside quotes counted, as a text editor shows it), and a
 * report's number `n` is always read as "the n-th row of the rows sent in that round".
 */
import {
  VALIDATE_LIST_ALL_MAX_FAILURES,
  type ValidationIssue,
  type ValidationReport,
} from "@datacanvas/database-core";

/**
 * The most rows that may be left out, over all the rounds: more is a file to fix, not "a few bad rows" (section 4.3,
 * item 1). The same limit as one `listAll` validation's.
 */
export const LEAVE_OUT_MAX_ROWS = VALIDATE_LIST_ALL_MAX_FAILURES;
/** The most validations in one leave-out: leaving rows out can reveal failures of the rules asked later (item 4). */
export const LEAVE_OUT_MAX_ROUNDS = 5;

/** The data rows of a file and, parallel to them, the file's line each one starts on. */
export interface DataRows {
  rows: readonly (readonly string[])[];
  lines: readonly number[];
}

/** The data rows of a parsed file (below the header, when there is one), each with its line. */
export function dataRowsWithLines(
  parsed: { rows: readonly (readonly string[])[]; lines: readonly number[] },
  header: boolean,
): DataRows {
  const skip = header ? 1 : 0;
  return { rows: parsed.rows.slice(skip), lines: parsed.lines.slice(skip) };
}

/** The file's line of the row a report numbers `row` (1-based among the rows sent). */
export function lineOfRequestRow(data: DataRows, row: number): number {
  checkRow(data, row);
  return data.lines[row - 1]!;
}

function checkRow(data: DataRows, row: number): void {
  if (!Number.isInteger(row) || row < 1 || row > data.rows.length) {
    throw new RangeError(`row ${row} is not one of the ${data.rows.length} rows sent`);
  }
}

/**
 * The rows that remain when the rows a report numbers (1-based among the rows sent) are left out, with their lines.
 * A number named twice is left out once; a number outside the rows sent is a mistake of the caller and throws.
 */
export function leaveOutRows(data: DataRows, failing: Iterable<number>): DataRows {
  const out = new Set<number>();
  for (const row of failing) {
    checkRow(data, row);
    out.add(row - 1);
  }
  const rows: (readonly string[])[] = [];
  const lines: number[] = [];
  data.rows.forEach((row, i) => {
    if (out.has(i)) return;
    rows.push(row);
    lines.push(data.lines[i]!);
  });
  return { rows, lines };
}

/** Why a row was left out: a rule and the names it is about (structure, never a value). */
export type RejectReason = Pick<ValidationIssue, "rule" | "column" | "constraint">;

/** A row left out: the file's line, the row as the file holds it, and every reason found for it. */
export interface Reject {
  line: number;
  row: readonly string[];
  reasons: RejectReason[];
}

/** The rows a report names, each with the reasons it names for it, in the order of the rows sent. */
export function failingRowsOf(report: ValidationReport): Map<number, RejectReason[]> {
  const byRow = new Map<number, RejectReason[]>();
  for (const issue of report.issues) {
    const reason: RejectReason = {
      rule: issue.rule,
      column: issue.column,
      constraint: issue.constraint,
    };
    for (const row of issue.rows) {
      const reasons = byRow.get(row) ?? [];
      if (!reasons.some((r) => sameReason(r, reason))) reasons.push(reason);
      byRow.set(row, reasons);
    }
  }
  return new Map([...byRow.entries()].sort(([a], [b]) => a - b));
}

const sameReason = (a: RejectReason, b: RejectReason): boolean =>
  a.rule === b.rule && a.column === b.column && a.constraint === b.constraint;

/** Validates rows (the dialog builds the request with `listAll` from them) and answers the server's report. */
export type ValidateRows = (
  rows: readonly (readonly string[])[],
  signal: AbortSignal,
) => Promise<ValidationReport>;

export type LeaveOutOutcome =
  /** A round found nothing: `data` is what to import, `rejects` what was left out (by line). */
  | { kind: "ready"; data: DataRows; rejects: Reject[]; rounds: number }
  /**
   * More than `LEAVE_OUT_MAX_ROWS` rows fail (a report stopped early, or the rows left out over the rounds would pass
   * the limit): nothing is left out, the file needs fixing. `atLeast` is a lower bound of the rows that fail.
   */
  | { kind: "too_many"; atLeast: number; rounds: number }
  /** `LEAVE_OUT_MAX_ROUNDS` validations each found failing rows. */
  | { kind: "rounds_exhausted"; rejects: Reject[]; rounds: number }
  /** Every row failed: there is nothing to import. */
  | { kind: "nothing_left"; rejects: Reject[]; rounds: number }
  /** A report counted failing rows without naming them, so they cannot be left out (the server did not list all). */
  | { kind: "not_listed"; rejects: Reject[]; rounds: number };

/**
 * Validate, leave out the rows that fail, and again, until a round finds nothing (section 4.3, item 4). The reasons
 * of a row accumulate in its reject. Cancelling `signal` rejects the promise with the signal's reason, before or
 * after any round, and no further round is asked.
 */
export async function planLeaveOut(
  start: DataRows,
  validate: ValidateRows,
  signal: AbortSignal,
): Promise<LeaveOutOutcome> {
  let data = start;
  const rejects = new Map<number, Reject>();
  const listed = () => [...rejects.values()].sort((a, b) => a.line - b.line);
  for (let round = 1; round <= LEAVE_OUT_MAX_ROUNDS; round++) {
    signal.throwIfAborted();
    const report = await validate(data.rows, signal);
    signal.throwIfAborted();
    const failing = failingRowsOf(report);
    const stopped = report.notChecked.includes("stopped_early");
    const counted = Math.max(failing.size, ...report.issues.map((i) => i.count));
    if (stopped || rejects.size + counted > LEAVE_OUT_MAX_ROWS) {
      return { kind: "too_many", atLeast: rejects.size + counted, rounds: round };
    }
    if (report.issues.length === 0) {
      return { kind: "ready", data, rejects: listed(), rounds: round };
    }
    if (report.issues.some((issue) => issue.count > issue.rows.length) || failing.size === 0) {
      return { kind: "not_listed", rejects: listed(), rounds: round };
    }
    for (const [row, reasons] of failing) {
      const line = lineOfRequestRow(data, row);
      const reject = rejects.get(line) ?? { line, row: data.rows[row - 1]!, reasons: [] };
      for (const reason of reasons) {
        if (!reject.reasons.some((r) => sameReason(r, reason))) reject.reasons.push(reason);
      }
      rejects.set(line, reject);
    }
    data = leaveOutRows(data, failing.keys());
    if (data.rows.length === 0) return { kind: "nothing_left", rejects: listed(), rounds: round };
  }
  return { kind: "rounds_exhausted", rejects: listed(), rounds: LEAVE_OUT_MAX_ROUNDS };
}
