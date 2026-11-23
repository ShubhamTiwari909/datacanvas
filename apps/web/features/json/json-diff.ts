/**
 * A line diff of two JSON documents, for the "Changes" view of the JSON editor: what was loaded
 * against what is in the editor, both laid out the same way first so that only real changes show.
 */
import { checkJson, layoutJson } from "./json-text";

export type DiffKind = "same" | "added" | "removed";
export interface DiffLine {
  kind: DiffKind;
  text: string;
}

/** The most lines per side compared: the table of the comparison grows with their product. */
export const DIFF_MAX_LINES = 2000;

/** The lines that differ between two lists of lines, or null when they are too long to compare. */
export function diffLines(before: readonly string[], after: readonly string[]): DiffLine[] | null {
  if (before.length > DIFF_MAX_LINES || after.length > DIFF_MAX_LINES) return null;
  // The longest common subsequence, as a table of lengths from the end.
  const rows = before.length + 1;
  const cols = after.length + 1;
  const table = new Uint16Array(rows * cols);
  for (let i = before.length - 1; i >= 0; i--) {
    for (let j = after.length - 1; j >= 0; j--) {
      table[i * cols + j] =
        before[i] === after[j]
          ? table[(i + 1) * cols + j + 1]! + 1
          : Math.max(table[(i + 1) * cols + j]!, table[i * cols + j + 1]!);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < before.length && j < after.length) {
    if (before[i] === after[j]) {
      out.push({ kind: "same", text: before[i]! });
      i += 1;
      j += 1;
    } else if (table[(i + 1) * cols + j]! >= table[i * cols + j + 1]!) {
      out.push({ kind: "removed", text: before[i]! });
      i += 1;
    } else {
      out.push({ kind: "added", text: after[j]! });
      j += 1;
    }
  }
  while (i < before.length) out.push({ kind: "removed", text: before[i++]! });
  while (j < after.length) out.push({ kind: "added", text: after[j++]! });
  return out;
}

/** A document as lines in the one layout (2 spaces), or its own lines when it is not valid JSON. */
function linesOf(text: string): string[] {
  const checked = checkJson(text);
  return (checked.ok ? layoutJson(checked.tokens, 2) : text).split(/\r\n|\r|\n/);
}

/** What changed between the loaded value and the text in the editor; null when too long to compare. */
export function diffDocuments(loaded: string, current: string): DiffLine[] | null {
  return diffLines(linesOf(loaded), linesOf(current));
}

export function countChanges(lines: readonly DiffLine[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of lines) {
    if (line.kind === "added") added += 1;
    else if (line.kind === "removed") removed += 1;
  }
  return { added, removed };
}
