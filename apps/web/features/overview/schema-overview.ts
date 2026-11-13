/**
 * The numbers behind the schema overview: what each schema contains and how it
 * connects to the others. Pure functions, no React and no network, so they are
 * easy to test.
 *
 * Inputs are what the app already reads (the table list of each schema, and
 * the database's declared foreign keys). Nothing here guesses: a table is an
 * "orphan" only if NO declared foreign key touches it, which for a database
 * without constraints says more about the database than about its design.
 */
import type { RelationshipInfo, TableInfo } from "@datacanvas/database-core";

/** How many entries each "top" list shows. */
export const OVERVIEW_TOP = 5;

export interface SchemaOverview {
  schema: string;
  tableCount: number;
  viewCount: number;
  materializedViewCount: number;
  /** Sum of the planner's row estimates; null when no table has one (never analysed). */
  estimatedRows: number | null;
  /** Foreign keys with both ends inside this schema. */
  relationshipsInside: number;
  /** Foreign keys from a table here to a table in another schema. */
  relationshipsOut: number;
  /** Foreign keys from another schema to a table here. */
  relationshipsIn: number;
  /** Other schemas this one is connected to, most connections first. */
  neighbours: Array<{ schema: string; count: number }>;
  /** Tables touched by the most foreign keys (only tables with at least one). */
  mostConnected: Array<{ name: string; degree: number }>;
  /** Ordinary tables (not views) that no foreign key touches. */
  orphans: string[];
  /** Tables with the highest row estimates. */
  largest: Array<{ name: string; estimatedRows: number }>;
}

export interface DatabaseOverview {
  schemaCount: number;
  tableCount: number;
  viewCount: number;
  materializedViewCount: number;
  relationshipCount: number;
  /** Foreign keys that cross from one schema to another. */
  crossSchemaRelationships: number;
  schemas: SchemaOverview[];
}

const key = (schema: string, name: string): string => JSON.stringify([schema, name]);

/** How many foreign keys touch each table. A self-reference counts once. */
export function relationshipDegrees(relationships: RelationshipInfo[]): Map<string, number> {
  const degrees = new Map<string, number>();
  for (const rel of relationships) {
    const ends = new Set([
      key(rel.source.schema, rel.source.table),
      key(rel.target.schema, rel.target.table),
    ]);
    for (const end of ends) degrees.set(end, (degrees.get(end) ?? 0) + 1);
  }
  return degrees;
}

export function computeSchemaOverview(
  schema: string,
  tables: TableInfo[],
  relationships: RelationshipInfo[],
  degrees: Map<string, number> = relationshipDegrees(relationships),
): SchemaOverview {
  let relationshipsInside = 0;
  let relationshipsOut = 0;
  let relationshipsIn = 0;
  const neighbourCounts = new Map<string, number>();
  for (const rel of relationships) {
    const fromHere = rel.source.schema === schema;
    const toHere = rel.target.schema === schema;
    if (fromHere && toHere) relationshipsInside += 1;
    else if (fromHere) {
      relationshipsOut += 1;
      neighbourCounts.set(rel.target.schema, (neighbourCounts.get(rel.target.schema) ?? 0) + 1);
    } else if (toHere) {
      relationshipsIn += 1;
      neighbourCounts.set(rel.source.schema, (neighbourCounts.get(rel.source.schema) ?? 0) + 1);
    }
  }

  const known = tables.flatMap((t) => (t.estimatedRowCount === null ? [] : [t.estimatedRowCount]));

  return {
    schema,
    tableCount: tables.filter((t) => t.kind === "table").length,
    viewCount: tables.filter((t) => t.kind === "view").length,
    materializedViewCount: tables.filter((t) => t.kind === "materialized_view").length,
    estimatedRows: known.length === 0 ? null : known.reduce((a, b) => a + b, 0),
    relationshipsInside,
    relationshipsOut,
    relationshipsIn,
    neighbours: [...neighbourCounts]
      .map(([name, count]) => ({ schema: name, count }))
      .sort((a, b) => b.count - a.count || a.schema.localeCompare(b.schema)),
    mostConnected: tables
      .map((t) => ({ name: t.name, degree: degrees.get(key(schema, t.name)) ?? 0 }))
      .filter((t) => t.degree > 0)
      .sort((a, b) => b.degree - a.degree || a.name.localeCompare(b.name))
      .slice(0, OVERVIEW_TOP),
    orphans: tables
      .filter((t) => t.kind === "table" && !degrees.has(key(schema, t.name)))
      .map((t) => t.name)
      .sort((a, b) => a.localeCompare(b)),
    largest: tables
      .flatMap((t) =>
        t.estimatedRowCount !== null && t.estimatedRowCount > 0
          ? [{ name: t.name, estimatedRows: t.estimatedRowCount }]
          : [],
      )
      .sort((a, b) => b.estimatedRows - a.estimatedRows || a.name.localeCompare(b.name))
      .slice(0, OVERVIEW_TOP),
  };
}

/** Overview of the whole database: totals plus one entry per schema, biggest first. */
export function computeDatabaseOverview(
  schemas: Array<{ schema: string; tables: TableInfo[] }>,
  relationships: RelationshipInfo[],
): DatabaseOverview {
  const degrees = relationshipDegrees(relationships);
  const perSchema = schemas
    .map(({ schema, tables }) => computeSchemaOverview(schema, tables, relationships, degrees))
    .sort(
      (a, b) =>
        b.tableCount +
          b.viewCount +
          b.materializedViewCount -
          (a.tableCount + a.viewCount + a.materializedViewCount) ||
        a.schema.localeCompare(b.schema),
    );
  const sum = (pick: (s: SchemaOverview) => number): number =>
    perSchema.reduce((total, s) => total + pick(s), 0);
  return {
    schemaCount: perSchema.length,
    tableCount: sum((s) => s.tableCount),
    viewCount: sum((s) => s.viewCount),
    materializedViewCount: sum((s) => s.materializedViewCount),
    relationshipCount: relationships.length,
    crossSchemaRelationships: relationships.filter((r) => r.source.schema !== r.target.schema)
      .length,
    schemas: perSchema,
  };
}
