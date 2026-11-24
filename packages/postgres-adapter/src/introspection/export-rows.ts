/**
 * The rows of a table, read for a FILE (`docs/advanced-data-workspace-plan.md`, section 8; decision 158).
 *
 * It is the page reader's own statement (`buildRowsQuery`: catalog names, quoted; every value bound; the
 * same sort and conditions, the same check that a hidden column is neither sorted nor filtered) opened as a
 * CURSOR in the read-only transaction the adapter gives every read, and fetched `EXPORT_BATCH_ROWS` at a
 * time, so the rows are never held: each batch is handed on and let go. A column whose name looks sensitive
 * is left OUT unless it was revealed, and the end of the stream says which.
 *
 * It stops at `EXPORT_MAX_ROWS`, when the consumer says stop (the byte limit is the consumer's, which
 * counts what it wrote), when the consumer's signal aborts, and after `EXPORT_MAX_MS` altogether. Values are
 * never logged, kept or put in an error.
 */
import {
  DatabaseError,
  EXPORT_BATCH_CHARS,
  EXPORT_BATCH_ROWS,
  EXPORT_FIRST_BATCH_ROWS,
  EXPORT_CELL_CHARS,
  EXPORT_MAX_ROWS,
  checkRowsFilters,
  checkRowsSort,
  isSensitiveColumnName,
  normalizeRowsOptions,
  safeSlice,
  type ExportSignal,
  type ExportEvent,
  type ExportRowsOptions,
  type RowColumn,
  type TableRef,
} from "@datacanvas/database-core";
import { listColumns } from "./columns.js";
import { buildRowsQuery, findColumnKinds, findRowKey } from "./rows.js";
import { listTablesByRef } from "./tables.js";
import type { Queryable } from "./types.js";

/** One export may hold its connection this long, whatever the table. */
export const EXPORT_MAX_MS = 10 * 60 * 1000;
/** A transaction that waits this long between two statements is ended by the server. */
export const EXPORT_IDLE_MS = 2 * 60 * 1000;

/** What the consumer answers to a batch: `false` means "enough, stop here". */
export type ExportSink = (event: ExportEvent) => void | boolean | Promise<void | boolean>;

const isDataException = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  typeof (error as { code?: unknown }).code === "string" &&
  (error as { code: string }).code.startsWith("22");

/**
 * Which columns an INSERT script cannot set (`GENERATED ... STORED`) and which it sets only with
 * `OVERRIDING SYSTEM VALUE` (`GENERATED ALWAYS AS IDENTITY`). Catalog flags only.
 */
const GENERATION_SQL = `
  SELECT a.attname::text AS name, a.attgenerated <> '' AS generated, a.attidentity = 'a' AS identity_always
  FROM pg_catalog.pg_attribute a
  JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped
`;

async function findColumnGeneration(
  db: Queryable,
  ref: TableRef,
): Promise<Map<string, { generated: boolean; identityAlways: boolean }>> {
  const { rows } = await db.query<{ name: string; generated: boolean; identity_always: boolean }>(
    GENERATION_SQL,
    [ref.schema, ref.name],
  );
  return new Map(
    rows.map((r) => [r.name, { generated: r.generated, identityAlways: r.identity_always }]),
  );
}

export async function exportRows(
  db: Queryable,
  ref: TableRef,
  options: ExportRowsOptions,
  sink: ExportSink,
  signal?: ExportSignal,
): Promise<void> {
  const {
    reveal,
    sort: requestedSort,
    filters: requestedFilters,
  } = normalizeRowsOptions({
    pageSize: 1,
    cursor: null,
    revealColumns: options.revealColumns,
    sort: options.sort ?? null,
    filters: options.filters ?? [],
  });

  // A reader that stops reading must not hold a transaction open for ever (the server ends the session).
  await db.query("SELECT set_config('idle_in_transaction_session_timeout', $1, true)", [
    String(EXPORT_IDLE_MS),
  ]);
  const [table] = await listTablesByRef(db, [ref]);
  if (!table) throw new DatabaseError("not_found");
  if (table.kind === "foreign_table") throw new DatabaseError("not_supported");

  // Every column: a file that quietly leaves some out would look complete (the page shows the first 100).
  const all = await listColumns(db, ref.schema, ref.name);
  const kinds = await findColumnKinds(db, ref);
  const generation = await findColumnGeneration(db, ref);
  const columns: RowColumn[] = all.map((c) => ({
    name: c.name,
    dataType: c.dataType,
    masked: isSensitiveColumnName(c.name) && !reveal.has(c.name),
    kind: kinds.get(c.name) ?? "other",
  }));
  const order = await findRowKey(db, ref);
  const sort = checkRowsSort(requestedSort, columns, order);
  const filters = checkRowsFilters(requestedFilters, columns);

  const shown = columns.flatMap((c, position) => (c.masked ? [] : [{ position, name: c.name }]));
  const leftOut = columns.filter((c) => c.masked).map((c) => c.name);
  const { text, values } = buildRowsQuery({
    schema: ref.schema,
    table: ref.name,
    shown,
    keyColumns: order.columns,
    after: null,
    sort,
    afterSort: null,
    filters,
    columnTypes: new Map(columns.map((c) => [c.name, c.dataType])),
    offset: 0,
    limit: EXPORT_MAX_ROWS + 1,
    cellChars: EXPORT_CELL_CHARS,
  });

  const started = Date.now();
  let stop = signal?.aborted ?? false;
  const proceed = async (event: ExportEvent): Promise<boolean> => {
    const answer = await sink(event);
    return answer !== false;
  };
  try {
    await db.query(`DECLARE dc_export NO SCROLL CURSOR FOR ${text}`, values);
  } catch (error) {
    // A value of a condition that does not fit its column: a fixed message, never the database's.
    if (isDataException(error)) throw new DatabaseError("invalid_request", { cause: error });
    throw error;
  }

  // Errors about the request (a value of the wrong type) come before the first event, so a caller can still answer them.
  if (stop) return;
  await proceed({
    kind: "start",
    columns: shown.map((s) => ({
      name: s.name,
      dataType: columns[s.position]!.dataType,
      generated: generation.get(s.name)?.generated ?? false,
      identityAlways: generation.get(s.name)?.identityAlways ?? false,
    })),
    leftOut,
  });

  let rows = 0;
  let cellsCut = 0;
  let cut: "rows" | "bytes" | null = null;
  // Batches are cut by size as well as by rows: a few rows of 1 MB cells must not be held 1,000 at a time.
  let fetchRows = EXPORT_FIRST_BATCH_ROWS;
  while (!stop) {
    if (signal?.aborted) return;
    if (Date.now() - started > EXPORT_MAX_MS) throw new DatabaseError("timeout");
    const { rows: batch } = await db.query<Record<string, string | null>>(
      `FETCH ${fetchRows} FROM dc_export`,
    );
    if (batch.length === 0) break;
    const out: Array<Array<string | null>> = [];
    let batchCut = 0;
    let chars = 0;
    for (const row of batch) {
      if (rows >= EXPORT_MAX_ROWS) {
        cut = "rows";
        stop = true;
        break;
      }
      out.push(
        shown.map((s) => {
          const value = row[`c${s.position}`] ?? null;
          if (value !== null && value.length > EXPORT_CELL_CHARS) {
            batchCut += 1;
            chars += EXPORT_CELL_CHARS;
            return safeSlice(value, EXPORT_CELL_CHARS);
          }
          chars += value?.length ?? 0;
          return value;
        }),
      );
      rows += 1;
    }
    cellsCut += batchCut;
    // The next fetch takes as many rows as fit in about `EXPORT_BATCH_CHARS`, at least one.
    const perRow = Math.max(1, chars / Math.max(1, out.length));
    fetchRows = Math.min(EXPORT_BATCH_ROWS, Math.max(1, Math.floor(EXPORT_BATCH_CHARS / perRow)));
    if (out.length > 0 && !(await proceed({ kind: "rows", rows: out, cellsCut: batchCut }))) {
      // The consumer is full. Say "cut" only if the table really has more.
      const { rows: more } = await db.query("FETCH 1 FROM dc_export");
      // A cut by rows stays a cut by rows.
      if (cut === null) cut = more.length > 0 ? "bytes" : null;
      stop = true;
    }
  }
  await db.query("CLOSE dc_export");
  if (signal?.aborted) return;
  await proceed({ kind: "end", rows, cut, cellsCut });
}
