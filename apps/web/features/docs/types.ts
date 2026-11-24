/**
 * What the documentation and diagram exports are made from (`docs/insight-release-plan.md`, section 7; decision 166):
 * the STRUCTURE that DataCanvas already holds (tables, columns, constraints, indexes, foreign keys). No row, no value,
 * no route: the files are made in the browser by pure functions and saved by the browser.
 */
import type { RelationshipInfo, TableDetailsEntry } from "@datacanvas/database-core";

export interface DocInput {
  /** The tables to describe, in the order to write them (sorted by `sortTables`). */
  tables: TableDetailsEntry[];
  /** Every relationship of the database: the ones between the chosen tables are written, the others are left out. */
  relationships: RelationshipInfo[];
  /** The name of the connection or database, for a heading. Cleaned before it is written. */
  title: string;
}

export const DOC_FORMATS = ["markdown", "mermaid", "dbml", "plantuml"] as const;
export type DocFormat = (typeof DOC_FORMATS)[number];

export interface DocFile {
  text: string;
  /** A name without a path: letters, digits, dot, dash and underscore only. */
  fileName: string;
  mimeType: string;
}

export const keyOf = (schema: string, name: string): string => `${schema}\u0000${name}`;

/** Tables in a fixed order (schema, then name), so the same database gives the same file every time. */
export function sortTables(tables: readonly TableDetailsEntry[]): TableDetailsEntry[] {
  return [...tables].sort(
    (a, b) =>
      a.table.schema.localeCompare(b.table.schema, "en") ||
      a.table.name.localeCompare(b.table.name, "en"),
  );
}

/** The relationships whose two ends are both among the chosen tables, in a fixed order. */
export function relationshipsAmong(input: DocInput): DocInput["relationships"] {
  const chosen = new Set(input.tables.map((t) => keyOf(t.table.schema, t.table.name)));
  return input.relationships
    .filter(
      (r) =>
        chosen.has(keyOf(r.source.schema, r.source.table)) &&
        chosen.has(keyOf(r.target.schema, r.target.table)),
    )
    .sort(
      (a, b) =>
        a.source.schema.localeCompare(b.source.schema, "en") ||
        a.source.table.localeCompare(b.source.table, "en") ||
        a.name.localeCompare(b.name, "en"),
    );
}
