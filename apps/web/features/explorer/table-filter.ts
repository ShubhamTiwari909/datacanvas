/**
 * The sidebar table search: narrow every schema's table list to the tables
 * and views whose NAME contains the text. Pure functions, so the rules are
 * tested without a browser.
 *
 * Matching is case-insensitive "contains" with a plain `includes`: `%`, `_`
 * and `\` are ordinary characters, never a pattern. Within a schema, names that
 * START with the text come first; otherwise the tree's own order is kept.
 * The text is only ever used here, in the browser (decision 136).
 */
import type { TableInfo } from "@datacanvas/database-core";
import type { SchemaTables } from "./load-all-tables";

export interface FilteredSchema {
  schema: string;
  tables: TableInfo[];
}

export interface TableFilterResult {
  schemas: FilteredSchema[];
  /** How many tables and views match. */
  matched: number;
  /** How many tables and views there are in all. */
  total: number;
}

function normalise(text: string): string {
  return text.toLowerCase();
}

export function filterSchemaTables(
  lists: readonly SchemaTables[],
  query: string,
): TableFilterResult {
  const needle = normalise(query.trim());
  let matched = 0;
  let total = 0;
  const schemas: FilteredSchema[] = [];

  for (const { schema, tables } of lists) {
    total += tables.length;
    const hits = tables
      .map((table, index) => ({ table, index, name: normalise(table.name) }))
      .filter((entry) => entry.name.includes(needle))
      .sort(
        (a, b) =>
          Number(!a.name.startsWith(needle)) - Number(!b.name.startsWith(needle)) ||
          a.index - b.index,
      )
      .map((entry) => entry.table);
    if (hits.length === 0) continue;
    matched += hits.length;
    schemas.push({ schema, tables: hits });
  }

  return { schemas, matched, total };
}

/** A name split around the first match, for marking it on screen. */
export interface MatchParts {
  before: string;
  match: string;
  after: string;
}

/**
 * Split `name` around the first case-insensitive occurrence of `query`, or
 * null when there is none or the match cannot be placed safely (a few letters
 * change length when lower-cased, such as "İ"; the name is then shown unmarked).
 * The parts are rendered as text, never as markup.
 */
export function splitMatch(name: string, query: string): MatchParts | null {
  const needle = normalise(query.trim());
  if (needle === "") return null;
  const lower = normalise(name);
  if (lower.length !== name.length) return null;
  const at = lower.indexOf(needle);
  if (at < 0) return null;
  return {
    before: name.slice(0, at),
    match: name.slice(at, at + needle.length),
    after: name.slice(at + needle.length),
  };
}
