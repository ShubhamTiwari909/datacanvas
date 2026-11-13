/**
 * Identifiers for canvas elements.
 *
 * A node's id is `tableRefKey` from database-core (a JSON array such as
 * `["public","users"]`), so the id of a table never depends on how it is
 * displayed and cannot clash for odd names (a dot in a schema or table name).
 *
 * Handles are the small connection points that edges attach to. Each COLUMN row
 * has one on each side, and the table header has a fallback pair used when the
 * column's row is hidden (a collapsed wide table).
 */
import { tableRefKey, type TableRef } from "@datacanvas/database-core";

export type HandleSide = "source" | "target";

export function nodeIdFor(ref: TableRef): string {
  return tableRefKey(ref);
}

/** Handle on a column row: edges start at `source`, and end at `target`. */
export function columnHandleId(side: HandleSide, column: string): string {
  return `${side}:column:${column}`;
}

/** Fallback handle on the table header. */
export function tableHandleId(side: HandleSide): string {
  return `${side}:table`;
}

/** The table a node id stands for, or null if the text is not a node id. The inverse of `nodeIdFor`. */
export function parseNodeId(id: string): TableRef | null {
  try {
    const parsed: unknown = JSON.parse(id);
    if (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      typeof parsed[0] === "string" &&
      typeof parsed[1] === "string"
    ) {
      return { schema: parsed[0], name: parsed[1] };
    }
  } catch {
    // not JSON: not one of our ids
  }
  return null;
}
