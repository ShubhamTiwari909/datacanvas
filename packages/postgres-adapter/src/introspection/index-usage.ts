import type { IndexUsage, IndexUsageReport } from "@datacanvas/database-core";
import { excludeSystemSchemas } from "./system-schemas.js";
import type { Queryable } from "./types.js";

/**
 * How often each index has been used, from the statistics collector's counters
 * (`pg_stat_all_indexes.idx_scan`). These are counters the server keeps about
 * itself; nothing here reads a table's rows.
 *
 * - Ordinary tables only (`relkind = 'r'`), and not partitions
 *   (`relispartition`): the partitioned table is the unit everywhere else. The
 *   index on a partitioned parent has no counters of its own (`relkind = 'I'`).
 * - LEFT JOIN: an index the collector has not seen yet has no row, which is
 *   the same as 0 scans.
 * - `backs_constraint`: a primary key, unique or exclusion constraint
 *   (`contype` p, u, x) owns the index through `conindid`; such an index cannot
 *   be dropped on its own. (A foreign key's `conindid` points at the REFERENCED
 *   table's key, not at an index of the referencing table, so it is not counted.)
 * - Numbers are cast to float8 so the driver returns JavaScript numbers (it
 *   returns bigint as text). Counters and sizes stay far below 2^53.
 */
const INDEX_USAGE_SQL = `
  SELECT
    n.nspname::text AS schema,
    t.relname::text AS "table",
    i.relname::text AS index,
    COALESCE(s.idx_scan, 0)::float8 AS scans,
    pg_catalog.pg_relation_size(ix.indexrelid)::float8 AS size_bytes,
    EXISTS (
      SELECT 1 FROM pg_catalog.pg_constraint con
      WHERE con.conindid = ix.indexrelid AND con.contype IN ('p', 'u', 'x')
    ) AS backs_constraint,
    ix.indisvalid AS valid
  FROM pg_catalog.pg_index ix
  JOIN pg_catalog.pg_class t ON t.oid = ix.indrelid
  JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
  JOIN pg_catalog.pg_class i ON i.oid = ix.indexrelid
  LEFT JOIN pg_catalog.pg_stat_all_indexes s ON s.indexrelid = ix.indexrelid
  WHERE t.relkind = 'r'
    AND i.relkind = 'i'
    AND NOT t.relispartition
    AND ${excludeSystemSchemas("n.nspname")}
  ORDER BY n.nspname, t.relname, i.relname
`;

/**
 * When the counters were last reset, and whether this server is a standby
 * (`pg_is_in_recovery()`): a standby counts only the queries run on itself.
 */
const STATS_SQL = `
  SELECT
    (SELECT d.stats_reset FROM pg_catalog.pg_stat_database d WHERE d.datname = current_database()) AS stats_reset,
    pg_catalog.pg_is_in_recovery() AS in_recovery
`;

interface UsageRow {
  schema: string;
  table: string;
  index: string;
  scans: number;
  size_bytes: number;
  backs_constraint: boolean;
  valid: boolean;
}
interface StatsRow {
  stats_reset: Date | string | null;
  in_recovery: boolean;
}

export async function listIndexUsage(db: Queryable): Promise<IndexUsageReport> {
  const usage = await db.query<UsageRow>(INDEX_USAGE_SQL);
  const stats = await db.query<StatsRow>(STATS_SQL);
  const row = stats.rows[0];
  const reset = row?.stats_reset ?? null;
  const resetDate = reset === null ? null : new Date(reset);
  return {
    statsReset:
      resetDate !== null && !Number.isNaN(resetDate.getTime()) ? resetDate.toISOString() : null,
    inRecovery: row?.in_recovery ?? false,
    indexes: usage.rows.map((r): IndexUsage => ({
      schema: r.schema,
      table: r.table,
      index: r.index,
      scans: r.scans,
      sizeBytes: r.size_bytes,
      backsConstraint: r.backs_constraint,
      valid: r.valid,
    })),
  };
}
