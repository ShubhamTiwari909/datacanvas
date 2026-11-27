/**
 * The KEYS of the rows a filter matches, for a change of those rows (`docs/write-side-v2-plan.md`, section 6 and
 * 13.4; decisions 2 and 3 of section 11). This is the ONE place a filter meets a change, and it only reads.
 *
 * It is the page reader's own statement (`buildRowsQuery`: catalog names, quoted; every value of a condition bound;
 * the same checks that a condition names a column that is read, is not hidden and allows its operator), asking for
 * the key columns only (no other column is read), ordered by the key, up to the row limit plus one (to learn
 * whether there are more). It runs as a CURSOR in the read-only transaction of the preview and is fetched one batch
 * at a time, so a filter that matches too much, or keys that are too long, stop the read early instead of being
 * held first.
 *
 * The keys come back as the keyed batches will bind them: one list per batch of `IMPORT_BATCH_ROWS`, each key the
 * values of the key columns in the key's order. Nothing else is read, and nothing is logged, kept or put in an error.
 */
import {
  DatabaseError,
  IMPORT_BATCH_ROWS,
  MATCHING_MAX_KEY_CHARS,
  MATCHING_MAX_KEY_VALUE_CHARS,
  MATCHING_MAX_ROWS,
  ROWS_MAX_COLUMNS,
  checkRowsFilters,
  isSensitiveColumnName,
  normalizeRowsOptions,
  type RowColumn,
  type RowFilter,
  type TableRef,
} from "@datacanvas/database-core";
import { listColumns } from "./columns.js";
import { buildRowsQuery, findColumnKinds } from "./rows.js";
import type { Queryable } from "./types.js";

/** How much the read may hold: rows, characters of every key value together, and characters of one key value. */
export interface MatchingLimits {
  rows: number;
  keyChars: number;
  keyValueChars: number;
}

export const MATCHING_LIMITS: MatchingLimits = {
  rows: MATCHING_MAX_ROWS,
  keyChars: MATCHING_MAX_KEY_CHARS,
  keyValueChars: MATCHING_MAX_KEY_VALUE_CHARS,
};

/** What the read found: the keys (in batches), or why it stopped. Never a value in a reason. */
export type MatchingKeys =
  | { kind: "keys"; count: number; batches: string[][][] }
  | { kind: "too_many_rows" }
  | { kind: "too_much_key_text" }
  | { kind: "key_value_too_long" };

/** The filter cannot be used: a fixed sentence that names no column and no value. */
export const FILTER_REFUSED =
  "This filter cannot be used for a change: a condition is on a column that is hidden, not shown, or does not allow it, or the filter is not complete.";
export const FILTER_VALUE_REFUSED =
  "A value of the filter is not valid for the type of its column, so no row was looked at.";

const isDataException = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  typeof (error as { code?: unknown }).code === "string" &&
  (error as { code: string }).code.startsWith("22");

/**
 * Read the keys of the rows the conditions match. `keyColumns` is the key the write will find the rows by (the
 * table's row key, from the catalog). An empty filter is refused here as well: this read never lists a whole table.
 */
export async function readMatchingKeys(
  db: Queryable,
  ref: TableRef,
  keyColumns: readonly string[],
  request: { filters: readonly RowFilter[]; revealColumns: readonly string[] },
  limits: MatchingLimits = MATCHING_LIMITS,
): Promise<MatchingKeys> {
  const refused = () => new DatabaseError("invalid_change", { message: FILTER_REFUSED });
  let options: ReturnType<typeof normalizeRowsOptions>;
  try {
    options = normalizeRowsOptions({
      pageSize: 1,
      cursor: null,
      revealColumns: [...request.revealColumns],
      filters: [...request.filters],
    });
  } catch {
    throw refused();
  }
  if (options.filters.length === 0 || keyColumns.length === 0) throw refused();

  // The columns a page reads (the first `ROWS_MAX_COLUMNS`), each hidden unless revealed: a condition is checked
  // against them exactly as the page reader checks it, so a filter on a hidden column cannot count its values.
  const all = await listColumns(db, ref.schema, ref.name);
  const kinds = await findColumnKinds(db, ref);
  const columns: RowColumn[] = all.slice(0, ROWS_MAX_COLUMNS).map((c) => ({
    name: c.name,
    dataType: c.dataType,
    masked: isSensitiveColumnName(c.name) && !options.reveal.has(c.name),
    kind: kinds.get(c.name) ?? "other",
  }));
  let filters: RowFilter[];
  try {
    filters = checkRowsFilters(options.filters, columns);
  } catch {
    throw refused();
  }

  const { text, values } = buildRowsQuery({
    schema: ref.schema,
    table: ref.name,
    shown: [],
    keyColumns,
    after: null,
    sort: null,
    afterSort: null,
    filters,
    columnTypes: new Map(columns.map((c) => [c.name, c.dataType])),
    offset: 0,
    limit: limits.rows + 1,
  });

  const batches: string[][][] = [];
  let count = 0;
  let chars = 0;
  let stop: Exclude<MatchingKeys["kind"], "keys"> | null = null;
  try {
    await db.query(`DECLARE dc_matching NO SCROLL CURSOR FOR ${text}`, values);
    while (stop === null) {
      const { rows } = await db.query<Record<string, string | null>>(
        `FETCH ${IMPORT_BATCH_ROWS} FROM dc_matching`,
      );
      if (rows.length === 0) break;
      const batch: string[][] = [];
      for (const row of rows) {
        count += 1;
        if (count > limits.rows) {
          stop = "too_many_rows";
          break;
        }
        const key = keyColumns.map((_, i) => row[`k${i}`]);
        // A key column is NOT NULL (the catalog chose it so): a NULL here means the table changed under the read.
        if (key.some((v) => typeof v !== "string")) throw new DatabaseError("unexpected");
        const held = key as string[];
        if (held.some((v) => v.length > limits.keyValueChars)) {
          stop = "key_value_too_long";
          break;
        }
        for (const v of held) chars += v.length;
        if (chars > limits.keyChars) {
          stop = "too_much_key_text";
          break;
        }
        batch.push(held);
      }
      if (stop === null) batches.push(batch);
    }
    await db.query("CLOSE dc_matching");
  } catch (error) {
    // A value of a condition that does not fit its column (or a pattern that is not one): a fixed message, never
    // the database's, which repeats the value.
    if (isDataException(error)) {
      throw new DatabaseError("invalid_change", { message: FILTER_VALUE_REFUSED, cause: error });
    }
    throw error;
  }
  return stop === null ? { kind: "keys", count, batches } : { kind: stop };
}
