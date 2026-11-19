/**
 * What completion knows about the database: its schemas, its tables and views with their
 * columns, and its functions. Built from the live structure the app already reads (names and
 * types only: no rows, no function bodies), kept in memory, never saved.
 */
import type { DatabaseStructure, RelationKind } from "@datacanvas/database-core";

export interface CatalogColumn {
  name: string;
  dataType: string;
}

export interface CatalogRelation {
  schema: string;
  name: string;
  kind: RelationKind;
  columns: CatalogColumn[];
}

export interface CatalogFunction {
  schema: string;
  name: string;
  arguments: string;
  returns: string | null;
}

export interface Catalog {
  schemas: string[];
  relations: CatalogRelation[];
  functions: CatalogFunction[];
}

export function buildCatalog(structure: DatabaseStructure): Catalog {
  return {
    schemas: [...structure.schemas],
    relations: structure.tables.map((t) => ({
      schema: t.schema,
      name: t.name,
      kind: t.kind,
      columns: t.columns.map((c) => ({ name: c.name, dataType: c.dataType })),
    })),
    functions: (structure.objects?.functions ?? []).map((f) => ({
      schema: f.schema,
      name: f.name,
      arguments: f.arguments,
      returns: f.returns,
    })),
  };
}

/** Names compare the way the database reads them, once the quotes are off: unquoted ones ignore case. */
export const sameName = (a: string, b: string, quoted = false): boolean =>
  quoted ? a === b : a.toLowerCase() === b.toLowerCase();

/**
 * The relations a name may mean. With a schema it is exact. Without one, PostgreSQL would use
 * the search path, which is not known here: `public` wins, then the other schemas in order.
 */
export function findRelations(
  catalog: Catalog,
  schema: string | null,
  name: string,
  quoted = false,
): CatalogRelation[] {
  const matches = catalog.relations.filter(
    (r) => sameName(r.name, name, quoted) && (schema === null || sameName(r.schema, schema)),
  );
  if (schema !== null || matches.length < 2) return matches;
  return [...matches].sort((a, b) => Number(b.schema === "public") - Number(a.schema === "public"));
}
