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

/** A typed name as PostgreSQL reads it: an unquoted one is folded to lower case, a quoted one is exact. */
export const fold = (name: string, quoted: boolean): string => (quoted ? name : name.toLowerCase());

/** A name PostgreSQL stored is exactly what it is; a typed one is folded first, and then compared exactly. */
export const matches = (stored: string, typed: string, typedQuoted: boolean): boolean =>
  stored === fold(typed, typedQuoted);

/** A schema as typed: its name and whether it was quoted. */
export interface TypedSchema {
  name: string;
  quoted: boolean;
}

/**
 * The relations a name may mean. With a schema it is exact. Without one, PostgreSQL would use
 * the search path, which is not known here: `public` wins, then the other schemas in order.
 */
export function findRelations(
  catalog: Catalog,
  schema: TypedSchema | null,
  name: string,
  quoted = false,
): CatalogRelation[] {
  const found = catalog.relations.filter(
    (r) =>
      matches(r.name, name, quoted) &&
      (schema === null || matches(r.schema, schema.name, schema.quoted)),
  );
  if (schema !== null || found.length < 2) return found;
  return [...found].sort((a, b) => Number(b.schema === "public") - Number(a.schema === "public"));
}
