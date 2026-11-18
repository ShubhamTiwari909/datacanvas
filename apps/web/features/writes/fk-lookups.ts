/**
 * What the foreign key rows read from the explorer (schemas, the tables of a
 * schema, a table's columns), shared between rows.
 *
 * Every foreign key row of a form needs the same lists, so without sharing a
 * table with a dozen foreign keys would ask for the same schemas and tables a
 * dozen times. Here one request is shared by all rows that ask for it while it
 * is in flight and for a few seconds after; a failure is not kept, so the next
 * ask tries again. The key includes the connection's structure version, so a
 * change of structure made from DataCanvas is never answered from before it.
 */
import { getSchemas, getTableDetails, getTables } from "@/features/explorer/api";
import type { ApiResult } from "@/lib/api-client";

/** How long an answer is shared. Short: names can change outside DataCanvas. */
export const LOOKUP_TTL_MS = 15_000;

interface Entry {
  at: number;
  promise: Promise<ApiResult<unknown>>;
}

const entries = new Map<string, Entry>();

export function shared<T>(
  key: string,
  load: () => Promise<ApiResult<T>>,
  now: () => number = Date.now,
): Promise<ApiResult<T>> {
  const hit = entries.get(key);
  if (hit && now() - hit.at < LOOKUP_TTL_MS) return hit.promise as Promise<ApiResult<T>>;
  const entry: Entry = { at: now(), promise: Promise.resolve({ ok: true, data: null }) };
  entry.promise = load().then((result) => {
    // A failure is not kept: the next ask tries again.
    if (!result.ok && entries.get(key) === entry) entries.delete(key);
    return result;
  });
  entries.set(key, entry);
  return entry.promise as Promise<ApiResult<T>>;
}

/** Forget everything shared (for tests). */
export function clearLookups(): void {
  entries.clear();
}

export const sharedSchemas = (connectionId: string, version: number) =>
  shared(JSON.stringify([connectionId, version, "schemas"]), () => getSchemas(connectionId));

export const sharedTables = (connectionId: string, version: number, schema: string) =>
  shared(JSON.stringify([connectionId, version, "tables", schema]), () =>
    getTables(connectionId, schema),
  );

export const sharedTableDetails = (
  connectionId: string,
  version: number,
  schema: string,
  table: string,
) =>
  shared(JSON.stringify([connectionId, version, "details", schema, table]), () =>
    getTableDetails(connectionId, schema, table),
  );
