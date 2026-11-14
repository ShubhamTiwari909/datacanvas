/**
 * A database's STRUCTURE as one plain, comparable value: the thing a snapshot
 * stores and the diff compares.
 *
 * It contains what the schema explorer reads (schemas, tables with their
 * columns, constraints and indexes, and the foreign keys) and deliberately NOT
 * the planner's row estimates: those change with every vacuum and would make
 * two snapshots of an unchanged database look different. No table rows are
 * ever part of it.
 *
 * Everything is sorted, so the same database always produces the same value
 * (and a snapshot file only changes when the structure does).
 */
import { normalizeObjects } from "./objects.js";
import type {
  ColumnInfo,
  ConstraintInfo,
  DatabaseObjects,
  IndexInfo,
  RelationKind,
  RelationshipInfo,
  TableDetailsEntry,
} from "./models.js";

export interface StructureTable {
  schema: string;
  name: string;
  kind: RelationKind;
  comment: string | null;
  columns: ColumnInfo[];
  constraints: ConstraintInfo[];
  indexes: IndexInfo[];
}

export interface DatabaseStructure {
  /** Every user schema, including empty ones. */
  schemas: string[];
  tables: StructureTable[];
  relationships: RelationshipInfo[];
  /**
   * Views, types, sequences, functions, triggers, extensions and policies.
   * `null` means "not recorded" (a snapshot taken before these were read), which
   * is not the same as there being none: a comparison skips them rather than
   * reporting every object as added.
   */
  objects: DatabaseObjects | null;
}

/** Order by code unit: unlike `localeCompare` it gives the same answer on every machine. */
export const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Assemble the structure from what the adapter returned. Schemas that only
 * appear on a table are added to the schema list, so the two can never disagree.
 */
export function buildStructure(
  schemas: readonly string[],
  entries: readonly TableDetailsEntry[],
  relationships: readonly RelationshipInfo[],
  objects: DatabaseObjects | null = null,
): DatabaseStructure {
  const tables = entries
    .map((entry): StructureTable => ({
      schema: entry.table.schema,
      name: entry.table.name,
      kind: entry.table.kind,
      comment: entry.table.comment,
      columns: [...entry.columns].sort((a, b) => a.ordinalPosition - b.ordinalPosition),
      constraints: [...entry.constraints].sort((a, b) => compareText(a.name, b.name)),
      indexes: [...entry.indexes].sort((a, b) => compareText(a.name, b.name)),
    }))
    .sort((a, b) => compareText(a.schema, b.schema) || compareText(a.name, b.name));

  return {
    schemas: [...new Set([...schemas, ...tables.map((t) => t.schema)])].sort(compareText),
    tables,
    relationships: [...relationships].sort(
      (a, b) =>
        compareText(a.source.schema, b.source.schema) ||
        compareText(a.source.table, b.source.table) ||
        compareText(a.name, b.name),
    ),
    objects: objects === null ? null : normalizeObjects(objects),
  };
}
