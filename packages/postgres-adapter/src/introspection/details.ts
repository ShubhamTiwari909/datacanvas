/**
 * Bulk metadata: description, columns, constraints and indexes of many tables
 * with exactly four queries, however many tables are asked for.
 */
import {
  DatabaseError,
  tableRefKey,
  uniqueTableRefs,
  type TableDetailsEntry,
  type TableRef,
} from "@datacanvas/database-core";
import { listColumnsFor } from "./columns.js";
import { listConstraintsFor } from "./constraints.js";
import { listIndexesFor } from "./indexes.js";
import { listTablesByRef } from "./tables.js";
import type { Queryable } from "./types.js";

export async function loadTablesDetails(
  db: Queryable,
  tables: readonly TableRef[],
): Promise<TableDetailsEntry[]> {
  const refs = uniqueTableRefs(tables);
  if (refs.length === 0) return [];

  // First the descriptions: a missing table shows up as a missing row here, and
  // we fail the whole call before doing any further work.
  const infos = new Map(
    (await listTablesByRef(db, refs)).map((info) => [
      tableRefKey({ schema: info.schema, name: info.name }),
      info,
    ]),
  );
  if (refs.some((ref) => !infos.has(tableRefKey(ref)))) throw new DatabaseError("not_found");

  // Sequential on purpose: they share one connection, which runs one query at a time anyway.
  const columns = await listColumnsFor(db, refs);
  const constraints = await listConstraintsFor(db, refs);
  const indexes = await listIndexesFor(db, refs);

  return refs.map((ref) => {
    const key = tableRefKey(ref);
    const table = infos.get(key);
    if (!table) throw new DatabaseError("not_found"); // unreachable: checked above
    return {
      table,
      columns: columns.get(key) ?? [],
      constraints: constraints.get(key) ?? [],
      indexes: indexes.get(key) ?? [],
    };
  });
}
