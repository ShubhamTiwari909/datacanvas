/**
 * Words and positions for the SQL view. Pure, so every rule is tested without a browser.
 */
import type { SqlFailure, SqlResult } from "@datacanvas/shared-types";

const number = new Intl.NumberFormat("en");

/** "1 row", "3 rows", "1,000 rows". */
export const rowsText = (count: number): string =>
  `${number.format(count)} ${count === 1 ? "row" : "rows"}`;

/** The line under a result: what ran, how many rows, how long, and what was left out. */
export function resultSummary(result: SqlResult): string[] {
  const parts = [rowsText(result.rows.length)];
  if (result.truncated) {
    parts.push(
      `Only the first ${number.format(result.rows.length)} rows are shown; the rest was not read`,
    );
  }
  if (result.cutCells > 0) {
    parts.push(
      `${number.format(result.cutCells)} ${result.cutCells === 1 ? "value was" : "values were"} cut`,
    );
  }
  parts.push(`${number.format(Math.round(result.elapsedMs))} ms`);
  return parts;
}

/** Seconds with one decimal under a minute, then minutes and seconds: "0.4 s", "12.0 s", "1 min 5 s". */
export function elapsedText(ms: number): string {
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
}

/** 1-based line and column of a 1-based character position in a text. */
export function lineColumn(text: string, position: number): { line: number; column: number } {
  const before = text.slice(0, Math.max(0, position - 1));
  const lines = before.split("\n");
  return { line: lines.length, column: (lines.at(-1)?.length ?? 0) + 1 };
}

/** The headline of a failure, from its code. */
export function failureTitle(failure: SqlFailure): string {
  switch (failure.code) {
    case "not_allowed":
      return "This statement cannot be run here";
    case "cancelled":
      return "The statement was cancelled";
    case "57014":
      return "The statement was stopped";
    default:
      return "The database refused this statement";
  }
}

/** The row limits the person can choose. */
export const ROW_LIMITS = [100, 1000, 5000, 10_000] as const;
export const DEFAULT_ROW_LIMIT = 1000;

/** A tab name from a statement: its first line, on one line, cut short. */
export function nameFromStatement(text: string): string {
  const line = text.split("\n").find((l) => l.trim() !== "") ?? "";
  const flat = line.replace(/\s+/g, " ").trim();
  return flat.length > 24 ? `${flat.slice(0, 24).trimEnd()}…` : flat || "Statement";
}

/** Does the statement already start with EXPLAIN (so another one in front would be an error)? */
export const startsWithExplain = (text: string): boolean =>
  /^(\s|--[^\n]*\n|\/\*[\s\S]*?\*\/)*explain\b/i.test(text);

/** "0.4 s" for a statement's time: milliseconds under a second. */
export function durationText(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : elapsedText(ms);
}
