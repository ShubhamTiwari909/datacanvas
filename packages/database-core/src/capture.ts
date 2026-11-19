/**
 * Read the whole structure of a database through an adapter: schemas, tables with their columns,
 * constraints and indexes, relationships, objects, and the definition detail a migration needs.
 * One place, so the snapshots, the live comparison and the migration tests all see a database the
 * same way. It reads names and settings, never rows.
 *
 * It stops before reading the details of a database that is too big to hold (`StructureTooLargeError`),
 * so a refusal costs a list of names and not a database's worth of definitions.
 */
import type { DatabaseAdapter } from "./adapter.js";
import {
  OBJECT_KINDS,
  type ObjectKind,
  type TableDetailsEntry,
  type TableInfo,
  type TableRef,
} from "./models.js";
import { buildStructure, type DatabaseStructure } from "./structure.js";

export interface CaptureLimits {
  maxTables: number;
  maxObjectsPerKind: number;
  /** Schemas whose tables are listed at the same time. */
  schemaBatch: number;
  /** Tables whose details are read in one call. */
  detailsBatch: number;
}

export class StructureTooLargeError extends Error {
  readonly what: "tables" | ObjectKind;
  readonly count: number;
  constructor(what: "tables" | ObjectKind, count: number) {
    super(`too many ${what}: ${count}`);
    this.name = "StructureTooLargeError";
    this.what = what;
    this.count = count;
  }
}

export async function captureStructure(
  adapter: DatabaseAdapter,
  limits: CaptureLimits,
): Promise<DatabaseStructure> {
  const schemas = (await adapter.getSchemas()).map((s) => s.name);
  // A few schemas at a time: a database with one schema per tenant must not send hundreds of
  // queries at once (that could exhaust the connection pool).
  const lists: TableInfo[][] = [];
  for (let start = 0; start < schemas.length; start += limits.schemaBatch) {
    lists.push(
      ...(await Promise.all(
        schemas.slice(start, start + limits.schemaBatch).map((schema) => adapter.getTables(schema)),
      )),
    );
  }
  const refs = lists.flat().map((t): TableRef => ({ schema: t.schema, name: t.name }));
  if (refs.length > limits.maxTables) throw new StructureTooLargeError("tables", refs.length);

  const entries: TableDetailsEntry[] = [];
  for (let start = 0; start < refs.length; start += limits.detailsBatch) {
    entries.push(
      ...(await adapter.getTablesDetails(refs.slice(start, start + limits.detailsBatch))),
    );
  }
  const relationships = await adapter.getRelationships();
  const objects = await adapter.getObjects();
  const tooMany = OBJECT_KINDS.find((kind) => objects[kind].length > limits.maxObjectsPerKind);
  if (tooMany !== undefined) throw new StructureTooLargeError(tooMany, objects[tooMany].length);
  const ddl = await adapter.getDdlDetail(refs, schemas);
  return buildStructure(schemas, entries, relationships, objects, ddl);
}
