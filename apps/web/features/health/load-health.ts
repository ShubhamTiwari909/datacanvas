/**
 * Fetch everything the health checks need and run them.
 *
 * The checks need the columns, constraints and indexes of every table, so this
 * is the one place that reads the details of a whole database. It goes through
 * the metadata cache (bulk requests of up to 500 tables), so tables already on
 * the canvas are not fetched twice, and the canvas benefits from what is
 * fetched here. Views are skipped: they have no keys or indexes of their own.
 */
import { tableRefKey, type TableDetailsEntry, type TableRef } from "@datacanvas/database-core";
import { loadAllTables } from "@/features/explorer/load-all-tables";
import type { ApiResult } from "@/lib/api-client";
import { useMetadataStore } from "@/stores/metadata-store";
import { runHealthChecks, type HealthReport } from "./health-checks";

/** Examine at most this many tables, so one click cannot pull the structure of a huge database. */
export const MAX_HEALTH_TABLES = 2000;

export interface LoadedHealth extends HealthReport {
  /** Tables that exist but were left out because of the limit. */
  skippedTables: number;
}

export async function loadHealth(connectionId: string): Promise<ApiResult<LoadedHealth>> {
  const listed = await loadAllTables(connectionId);
  if (!listed.ok) return listed;

  const allTables: TableRef[] = listed.data.flatMap(({ schema, tables }) =>
    tables.filter((t) => t.kind === "table").map((t) => ({ schema, name: t.name })),
  );
  const refs = allTables.slice(0, MAX_HEALTH_TABLES);

  const metadata = useMetadataStore.getState();
  const [details, relationships] = await Promise.all([
    metadata.ensureTables(connectionId, refs),
    metadata.ensureRelationships(connectionId),
  ]);
  const failure = !details.ok ? details : !relationships.ok ? relationships : null;
  if (failure && !failure.ok) {
    return { ok: false, error: { code: "unexpected", message: failure.message, issues: [] } };
  }

  const cache = useMetadataStore.getState().byConnection[connectionId];
  const entries = refs.flatMap((ref) => {
    const entry: TableDetailsEntry | undefined = cache?.tables[tableRefKey(ref)];
    return entry ? [entry] : [];
  });
  const report = runHealthChecks(entries, cache?.relationships ?? []);
  return { ok: true, data: { ...report, skippedTables: allTables.length - refs.length } };
}
