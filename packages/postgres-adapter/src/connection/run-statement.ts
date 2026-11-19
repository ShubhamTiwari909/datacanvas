/**
 * Run ONE statement the person typed, read-only, on a connection of its own
 * (1.6.0, decision 141; `docs/sql-workspace-plan.md` section 3.2).
 *
 * Why a connection of its own and not the pool: a statement such as
 * `SET SESSION default_transaction_read_only = off` changes the connection it
 * runs on, and a pooled connection is later used by a write transaction. Here the
 * connection is opened for this run and closed after it, in every case.
 *
 * Why one statement: the extended protocol (a NAMED statement) is used, and the
 * server refuses more than one command in it. With the simple protocol a text
 * such as `SELECT 1; COMMIT; DROP TABLE x` would end our read-only transaction
 * and run the rest.
 *
 * Rows: a `SELECT`-like statement is wrapped in a cursor and only `maxRows + 1`
 * rows are fetched, so a result of millions of rows never crosses the wire. The
 * wrapped text is `DECLARE ... CURSOR FOR <text>`, which the server parses as a
 * query and nothing else. Every value is returned as text.
 */
import {
  firstKeyword,
  SQL_LIMITS,
  SqlStatementError,
  type SqlResultColumn,
  type SqlRunRequest,
  type SqlRunResult,
} from "@datacanvas/database-core";
import pg from "pg";

const CURSOR = "dc_sql_cursor";
const CURSOR_PREFIX = `DECLARE ${CURSOR} NO SCROLL CURSOR FOR `;
const QUERY_WORDS = ["select", "with", "values", "table"];
/** A name for the statement: it makes the driver use the extended protocol. */
const STATEMENT_NAME = "dc_sql_statement";
const MAX_MESSAGE_CHARS = 2000;
/** Rows fetched at a time, so a result of very large rows is stopped at the byte budget, not after it is all in memory. */
const BATCH_ROWS = 25;
/** How often a cancel is sent again until the run ends, and how many times before the backend is ended. */
const CANCEL_EVERY_MS = 250;
const CANCEL_TRIES = 12;
const CANCELLED = "The query was cancelled.";

const BOOLEAN_OID = 16;

/**
 * Every value as text: no number, date or JSON parsing. A boolean is the one change: the server
 * sends `t` and `f`, and the rest of the app (which casts to text in the database) says
 * `true` and `false`.
 */
const TEXT_ONLY = {
  getTypeParser: (oid: number) =>
    oid === BOOLEAN_OID
      ? (value: string) => (value === "t" ? "true" : "false")
      : (value: string) => value,
};

export async function runStatementOnOwnConnection(
  config: pg.PoolConfig,
  request: SqlRunRequest,
  /** The byte budget of the result; the limit of the product unless a test asks for a smaller one. */
  maxResultBytes: number = SQL_LIMITS.maxResultBytes,
): Promise<SqlRunResult> {
  const { signal } = request;
  if (signal?.aborted) throw new SqlStatementError("cancelled", CANCELLED);

  const { ssl, ...rest } = config;
  const client = new pg.Client({
    ...rest,
    ssl,
    application_name: "DataCanvas SQL",
    // A backstop only: the server's own statement timeout fires first.
    query_timeout: request.timeoutMs + 5000,
  });
  client.on("error", () => {}); // a dropped connection is reported by the query that was waiting
  let opened = false;
  let aborted = false;
  /** The run is over, one way or the other: no more cancels. */
  let settled = false;
  let stopWaiting: () => void = () => {};
  const processId = (): number | undefined =>
    (client as unknown as { processID?: number }).processID;

  /**
   * Cancel the statement, and keep asking: a cancel only reaches a statement that is running,
   * so one sent between two of our queries, or before the connection is up, would be lost. After
   * a few tries the backend is ended.
   */
  const cancelUntilSettled = async (): Promise<void> => {
    for (let i = 0; i < CANCEL_TRIES && !settled; i++) {
      await signalBackend(config, processId(), "pg_cancel_backend");
      if (settled) return;
      await new Promise((resolve) => setTimeout(resolve, CANCEL_EVERY_MS));
    }
    if (!settled) await signalBackend(config, processId(), "pg_terminate_backend");
  };
  const onAbort = (): void => {
    aborted = true;
    stopWaiting();
    void cancelUntilSettled();
  };
  const throwIfAborted = (): void => {
    if (aborted) throw new SqlStatementError("cancelled", CANCELLED);
  };

  // Listening starts before the connection does: an abort while it is being made ends the wait
  // at once instead of after the connect timeout.
  signal?.addEventListener("abort", onAbort, { once: true });
  const aborts = new Promise<never>((_, reject) => {
    stopWaiting = () => reject(new SqlStatementError("cancelled", CANCELLED));
  });
  aborts.catch(() => {});

  try {
    const connecting = client.connect();
    try {
      await Promise.race([connecting, aborts]);
    } catch (error) {
      // The attempt goes on in the background; whatever it makes is ended as soon as it exists.
      void connecting.then(
        () => client.end().catch(() => {}),
        () => {},
      );
      throw error;
    }
    opened = true;
    throwIfAborted();
    await client.query("BEGIN READ ONLY");
    await client.query(
      `SELECT set_config('statement_timeout', $1, true),
              set_config('lock_timeout', $2, true),
              set_config('idle_in_transaction_session_timeout', $3, true),
              set_config('default_transaction_read_only', 'on', false)`,
      [
        String(request.timeoutMs),
        String(SQL_LIMITS.lockTimeoutMs),
        String(request.timeoutMs + 10_000),
      ],
    );
    throwIfAborted();

    const started = Date.now();
    const deadline = started + request.timeoutMs;
    const word = firstKeyword(request.text);
    const asCursor = word !== null && QUERY_WORDS.includes(word);
    let raw: Raw;
    try {
      raw = asCursor
        ? await readThroughCursor(client, request, throwIfAborted, deadline, maxResultBytes)
        : await readPlain(client, request, maxResultBytes);
    } catch (error) {
      throw aborted
        ? new SqlStatementError("cancelled", CANCELLED)
        : toStatementError(error, asCursor ? CURSOR_PREFIX.length : 0);
    }
    const truncated = raw.rows.length > request.maxRows || raw.budgetHit;
    const kept = raw.rows.length > request.maxRows ? raw.rows.slice(0, request.maxRows) : raw.rows;
    // An abort that lands while the columns are described or the transaction ends is still a cancel.
    let columns: SqlResultColumn[];
    try {
      throwIfAborted();
      columns = await describeColumns(client, raw.fields);
      throwIfAborted();
      await client.query("COMMIT");
      throwIfAborted();
    } catch (error) {
      throw aborted ? new SqlStatementError("cancelled", CANCELLED) : error;
    }
    const cut = cutLongCells(kept);
    return {
      columns,
      rows: cut.rows,
      truncated,
      command: raw.command,
      cutCells: cut.cutCells,
      elapsedMs: Date.now() - started,
    };
  } finally {
    settled = true;
    signal?.removeEventListener("abort", onAbort);
    // Only a connection that opened can be ended (ending a failed one can hang). Ending drops
    // the transaction and every session setting with it.
    if (opened) await client.end().catch(() => {});
  }
}

interface Raw {
  fields: pg.FieldDef[];
  rows: (string | null)[][];
  command: string;
  /** The result reached the byte budget: the rest was not read. */
  budgetHit: boolean;
}

async function readThroughCursor(
  client: pg.Client,
  request: SqlRunRequest,
  throwIfAborted: () => void,
  deadline: number,
  maxResultBytes: number,
): Promise<Raw> {
  await client.query({ name: STATEMENT_NAME, text: CURSOR_PREFIX + request.text });
  throwIfAborted();
  const rows: (string | null)[][] = [];
  let fields: pg.FieldDef[] = [];
  let bytes = 0;
  let budgetHit = false;
  fetching: while (rows.length < request.maxRows + 1) {
    // One time limit for the whole statement, not one per fetch: what is left of it goes to the server.
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new SqlStatementError("57014", "canceling statement due to statement timeout");
    }
    if (rows.length > 0) {
      await client.query("SELECT set_config('statement_timeout', $1, true)", [String(remaining)]);
    }
    // The first fetch is one row, to see how big rows are; after that as many as fit twice over in
    // what is left of the byte budget (at most a batch), so a batch is never much larger than it.
    const average = rows.length > 0 ? bytes / rows.length : Number.POSITIVE_INFINITY;
    const room = maxResultBytes - bytes;
    const fit = Number.isFinite(average) ? Math.max(1, Math.floor(room / (average * 2 + 1))) : 1;
    const want = Math.min(BATCH_ROWS, fit, request.maxRows + 1 - rows.length);
    const fetched = await client.query({
      text: `FETCH FORWARD ${want} FROM ${CURSOR}`,
      rowMode: "array",
      types: TEXT_ONLY,
    });
    if (fields.length === 0) fields = fetched.fields;
    for (const row of fetched.rows as (string | null)[][]) {
      const size = rowBytes(row);
      if (rows.length > 0 && bytes + size > maxResultBytes) {
        budgetHit = true;
        break fetching;
      }
      rows.push(row);
      bytes += size;
    }
    if (fetched.rows.length < want) break; // the cursor is exhausted
    throwIfAborted();
  }
  return { fields, rows, command: "SELECT", budgetHit };
}

/** The bytes a row takes as UTF-8, which is what the budget counts. */
function rowBytes(row: readonly (string | null)[]): number {
  let size = 0;
  for (const cell of row) if (cell !== null) size += Buffer.byteLength(cell, "utf8");
  return size;
}

async function readPlain(
  client: pg.Client,
  request: SqlRunRequest,
  maxResultBytes: number,
): Promise<Raw> {
  const result = await client.query({
    name: STATEMENT_NAME,
    text: request.text,
    rowMode: "array",
    types: TEXT_ONLY,
  });
  // EXPLAIN and SHOW are small and cannot be read in pieces, but the same limits apply to what is kept.
  const rows: (string | null)[][] = [];
  let bytes = 0;
  let budgetHit = false;
  for (const row of result.rows as (string | null)[][]) {
    const size = rowBytes(row);
    if (rows.length > 0 && bytes + size > maxResultBytes) {
      budgetHit = true;
      break;
    }
    rows.push(row);
    bytes += size;
  }
  return { fields: result.fields, rows, command: result.command ?? "", budgetHit };
}

/** Type names as the database prints them, with length and precision. */
async function describeColumns(
  client: pg.Client,
  fields: pg.FieldDef[],
): Promise<SqlResultColumn[]> {
  if (fields.length === 0) return [];
  const { rows } = await client.query<{ type: string }>(
    `SELECT pg_catalog.format_type(u.oid, u.mod) AS type
     FROM unnest($1::oid[], $2::int[]) WITH ORDINALITY AS u(oid, mod, ord) ORDER BY u.ord`,
    [fields.map((f) => f.dataTypeID), fields.map((f) => f.dataTypeModifier)],
  );
  return fields.map((f, i) => ({ name: f.name, dataType: rows[i]?.type ?? "unknown" }));
}

function cutLongCells(rows: (string | null)[][]): { rows: (string | null)[][]; cutCells: number } {
  let count = 0;
  const limit = SQL_LIMITS.maxCellChars;
  const out = rows.map((row) =>
    row.map((cell) => {
      if (cell === null || cell.length <= limit) return cell;
      count++;
      const cut = cell.slice(0, limit);
      // Never end in the first half of a surrogate pair.
      return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
    }),
  );
  return { rows: out, cutCells: count };
}

/**
 * A failure of the person's statement becomes a `SqlStatementError` (the server's own sentence,
 * its code and the position). Anything else (the connection dropped) is rethrown to be mapped.
 */
function toStatementError(error: unknown, offset: number): unknown {
  if (typeof error !== "object" || error === null) return error;
  const e = error as { code?: unknown; message?: unknown; severity?: unknown; position?: unknown };
  if (
    typeof e.code === "string" &&
    /^[0-9A-Z]{5}$/.test(e.code) &&
    typeof e.message === "string" &&
    typeof e.severity === "string"
  ) {
    const raw = typeof e.position === "string" ? Number(e.position) : NaN;
    const position = Number.isFinite(raw) && raw > offset ? raw - offset : null;
    return new SqlStatementError(e.code, e.message.slice(0, MAX_MESSAGE_CHARS), position);
  }
  return error;
}

/** Ask the server to cancel (or end) a backend, from a second short-lived connection. Never throws. */
async function signalBackend(
  config: pg.PoolConfig,
  pid: number | undefined,
  action: "pg_cancel_backend" | "pg_terminate_backend",
): Promise<void> {
  if (!pid) return;
  const { ssl, ...rest } = config;
  const canceller = new pg.Client({ ...rest, ssl, application_name: "DataCanvas SQL cancel" });
  canceller.on("error", () => {});
  let opened = false;
  try {
    await canceller.connect();
    opened = true;
    await canceller.query(`SELECT ${action}($1)`, [pid]);
  } catch {
    // The statement may already be over; the next try, or the run's own timeout, is the backstop.
  } finally {
    if (opened) await canceller.end().catch(() => {});
  }
}
