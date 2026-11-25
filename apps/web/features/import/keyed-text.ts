/**
 * The sentences of an import by key (`docs/write-side-v2-plan.md`, 4.1 and 4.2) in the preview and after it is
 * applied: counts and the file's line numbers only, never a key or a value. Pure functions, no React.
 */
import type { AppliedChange, Change, RowCounts } from "@datacanvas/database-core";
import { rowsWords } from "./import-plan";

/** At most this many lines of the file are named for the rows an update finds no row for. */
export const SKIPPED_LINES_LISTED = 20;

/** Whether a change is an import by key (an update or insert, or an update only). */
export const isKeyedImport = (change: Change): boolean =>
  change.kind === "upsert_rows" || change.kind === "update_by_key";

const is = (n: number) => (n === 1 ? "is" : "are");

/** The first line of the preview of an import by key: what the preview counted. Null for any other change. */
export function countsText(change: Change, counts: RowCounts | null): string | null {
  if (counts === null) return null;
  if (change.kind === "update_by_key") return `${rowsWords(counts.update)} will be updated.`;
  if (change.kind !== "upsert_rows") return null;
  if (change.updateColumns.length === 0) {
    const existing = counts.unchanged;
    return `${rowsWords(counts.insert)} will be added; ${rowsWords(existing)} already ${existing === 1 ? "exists" : "exist"} and ${is(existing)} left as ${existing === 1 ? "it is" : "they are"}.`;
  }
  return `${rowsWords(counts.insert)} will be added and ${rowsWords(counts.update)} overwritten.`;
}

/**
 * The rows of the file an update finds no row for, by their line in the file. `skipped` holds positions in the rows
 * sent (0-based); `lines` gives the file's line of each of them. Without `lines`, the positions are counted from 1.
 */
export function skippedText(skipped: readonly number[], lines?: readonly number[]): string {
  const count = skipped.length;
  const shown = skipped.slice(0, SKIPPED_LINES_LISTED).map((p) => lines?.[p] ?? p + 1);
  const word = lines ? (count === 1 ? "line" : "lines") : count === 1 ? "row" : "rows";
  const more =
    count > shown.length ? ` and ${(count - shown.length).toLocaleString("en-US")} more` : "";
  return `${rowsWords(count)} of the file ${count === 1 ? "finds" : "find"} no row and ${is(count)} left out (${word} ${shown.map((n) => n.toLocaleString("en-US")).join(", ")}${more}).`;
}

/** What an applied import by key says: how the rows split when the server says so, else the total. */
export function appliedText(
  change: Change,
  result: Pick<AppliedChange, "rowCount" | "split">,
): string {
  const were = (n: number) => `${rowsWords(n)} ${n === 1 ? "was" : "were"}`;
  if (change.kind === "update_by_key")
    return `${were(result.split?.updated ?? result.rowCount)} updated.`;
  const split = result.split;
  if (!split) return `${were(result.rowCount)} added or updated.`;
  if (change.kind === "upsert_rows" && change.updateColumns.length === 0) {
    return `${were(split.inserted)} added; the rows already in the table were left as they are.`;
  }
  const n = (count: number) => count.toLocaleString("en-US");
  return split.exact
    ? `${were(split.inserted)} added and ${n(split.updated)} updated.`
    : `${were(result.rowCount)} added or updated: about ${n(split.inserted)} added and about ${n(split.updated)} updated.`;
}
