import type { ColumnStatistics, TableRef, TableStatistics } from "@datacanvas/database-core";
import type { Queryable } from "./types.js";

/**
 * What the server's own statistics say about one table (`docs/insight-release-plan.md`, section 6; decision 165):
 * the share of NULLs, the number of distinct values, the width and the order of each column (`pg_stats`), the size of
 * the table, its indexes and its TOAST data, and when it was last vacuumed and analysed (`pg_stat_all_tables`).
 *
 * **No row of the table is read, and no VALUE is.** `pg_stats` also holds `most_common_vals`, `most_common_freqs`,
 * `histogram_bounds` and `most_common_elems`: they are values of the table. They are never selected here: the column
 * list below is written out (never `s.*`), and a rule test (`tests/security.test.ts`) fails if any statement of this
 * file names one of them.
 *
 * `pg_stats` shows a column only to a role that may select it, and only once the table was analysed: a column without
 * a row has no figures, which is said in words, never shown as zero. Numbers are cast to float8 so the driver returns
 * JavaScript numbers.
 */
const TABLE_SQL = `
  SELECT
    c.oid::text AS oid,
    c.relkind::text AS relkind,
    c.reltuples::float8 AS estimated_rows,
    pg_catalog.pg_table_size(c.oid)::float8 AS table_bytes,
    pg_catalog.pg_indexes_size(c.oid)::float8 AS index_bytes,
    COALESCE(pg_catalog.pg_total_relation_size(NULLIF(c.reltoastrelid, 0)), 0)::float8 AS toast_bytes,
    st.n_live_tup::float8 AS live_rows,
    st.n_dead_tup::float8 AS dead_rows,
    st.last_vacuum,
    st.last_autovacuum,
    st.last_analyze,
    st.last_autoanalyze
  FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  LEFT JOIN pg_catalog.pg_stat_all_tables st ON st.relid = c.oid
  WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind IN ('r', 'p', 'm')
`;

const COLUMNS_SQL = `
  SELECT
    a.attname::text AS name,
    s.null_frac::float8 AS null_fraction,
    s.n_distinct::float8 AS n_distinct,
    s.avg_width::float8 AS avg_width,
    s.correlation::float8 AS correlation,
    (s.attname IS NOT NULL) AS has_statistics
  FROM pg_catalog.pg_attribute a
  JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  LEFT JOIN pg_catalog.pg_stats s
    ON s.schemaname = n.nspname AND s.tablename = c.relname AND s.attname = a.attname
    AND s.inherited = (c.relkind = 'p')
  WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped
  ORDER BY a.attnum
`;

interface TableRow {
  oid: string;
  relkind: string;
  estimated_rows: number;
  table_bytes: number;
  index_bytes: number;
  toast_bytes: number;
  live_rows: number | null;
  dead_rows: number | null;
  last_vacuum: Date | null;
  last_autovacuum: Date | null;
  last_analyze: Date | null;
  last_autoanalyze: Date | null;
}

interface ColumnRow {
  name: string;
  null_fraction: number | null;
  n_distinct: number | null;
  avg_width: number | null;
  correlation: number | null;
  has_statistics: boolean;
}

const iso = (value: Date | null): string | null =>
  value instanceof Date ? value.toISOString() : null;

/**
 * `reltuples` is -1 before the first ANALYZE or VACUUM from PostgreSQL 14, and 0 before that (12 and 13): neither is a
 * count. A table that was never vacuumed or analysed and says 0 is "not known", not "empty".
 */
function estimate(row: TableRow): number | null {
  if (row.estimated_rows < 0) return null;
  const never =
    !row.last_vacuum && !row.last_autovacuum && !row.last_analyze && !row.last_autoanalyze;
  return row.estimated_rows === 0 && never ? null : row.estimated_rows;
}

/**
 * The statistics of a table, partitioned table or materialized view; null when the name is none of those (a view or a
 * foreign table has no storage of its own, and a missing table is not an error here: the person asked about a name).
 */
export async function readTableStatistics(
  db: Queryable,
  table: TableRef,
): Promise<TableStatistics | null> {
  const { rows } = await db.query<TableRow>(TABLE_SQL, [table.schema, table.name]);
  const row = rows[0];
  if (!row) return null;
  const columns = await db.query<ColumnRow>(COLUMNS_SQL, [table.schema, table.name]);
  const mapped: ColumnStatistics[] = columns.rows.map((c) => {
    const distinct = c.n_distinct;
    return {
      column: c.name,
      hasStatistics: c.has_statistics,
      nullFraction: c.null_fraction,
      // n_distinct is a count when positive and minus a share of the rows when negative (-1 = every row differs).
      distinctValues: distinct !== null && distinct > 0 ? distinct : null,
      distinctShare: distinct !== null && distinct < 0 ? -distinct : null,
      averageWidth: c.avg_width,
      correlation: c.correlation,
    };
  });
  return {
    table: { schema: table.schema, name: table.name },
    kind: row.relkind === "p" ? "partitioned" : row.relkind === "m" ? "materialized" : "table",
    estimatedRows: estimate(row),
    liveRows: row.live_rows,
    deadRows: row.dead_rows,
    tableBytes: row.table_bytes,
    indexBytes: row.index_bytes,
    toastBytes: row.toast_bytes,
    lastVacuum: iso(row.last_vacuum),
    lastAutovacuum: iso(row.last_autovacuum),
    lastAnalyze: iso(row.last_analyze),
    lastAutoanalyze: iso(row.last_autoanalyze),
    columns: mapped,
  };
}
