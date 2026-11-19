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
  const onAbort = (): void => {
    aborted = true;
    void cancelBackend(config, (client as unknown as { processID?: number }).processID);
  };

  try {
    await client.connect();
    opened = true;
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
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
    if (aborted) throw new SqlStatementError("cancelled", CANCELLED);

    const started = Date.now();
    const word = firstKeyword(request.text);
    const asCursor = word !== null && QUERY_WORDS.includes(word);
    let raw: { fields: pg.FieldDef[]; rows: (string | null)[][]; command: string };
    try {
      raw = asCursor ? await readThroughCursor(client, request) : await readPlain(client, request);
    } catch (error) {
      throw aborted
        ? new SqlStatementError("cancelled", CANCELLED)
        : toStatementError(error, asCursor ? CURSOR_PREFIX.length : 0);
    }
    const truncated = raw.rows.length > request.maxRows;
    const kept = truncated ? raw.rows.slice(0, request.maxRows) : raw.rows;
    const columns = await describeColumns(client, raw.fields);
    await client.query("COMMIT");
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
    signal?.removeEventListener("abort", onAbort);
    // Only a connection that opened can be ended (ending a failed one can hang). Ending drops
    // the transaction and every session setting with it.
    if (opened) await client.end().catch(() => {});
  }
}

async function readThroughCursor(client: pg.Client, request: SqlRunRequest) {
  await client.query({ name: STATEMENT_NAME, text: CURSOR_PREFIX + request.text });
  const fetched = await client.query({
    text: `FETCH FORWARD ${request.maxRows + 1} FROM ${CURSOR}`,
    rowMode: "array",
    types: TEXT_ONLY,
  });
  return {
    fields: fetched.fields,
    rows: fetched.rows as (string | null)[][],
    command: "SELECT",
  };
}

async function readPlain(client: pg.Client, request: SqlRunRequest) {
  const result = await client.query({
    name: STATEMENT_NAME,
    text: request.text,
    rowMode: "array",
    types: TEXT_ONLY,
  });
  return {
    fields: result.fields,
    rows: result.rows as (string | null)[][],
    command: result.command ?? "",
  };
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

/** Ask the server to cancel a backend, from a second short-lived connection. Never throws. */
async function cancelBackend(config: pg.PoolConfig, pid: number | undefined): Promise<void> {
  if (!pid) return;
  const { ssl, ...rest } = config;
  const canceller = new pg.Client({ ...rest, ssl, application_name: "DataCanvas SQL cancel" });
  canceller.on("error", () => {});
  let opened = false;
  try {
    await canceller.connect();
    opened = true;
    await canceller.query("SELECT pg_cancel_backend($1)", [pid]);
  } catch {
    // The statement may already be over; the run's own timeout is the backstop.
  } finally {
    if (opened) await canceller.end().catch(() => {});
  }
}
