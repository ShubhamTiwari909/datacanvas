/**
 * The transaction a VALIDATION runs in (`docs/advanced-data-workspace-plan.md`, section 6.2, decision 157).
 *
 * A validation makes a temporary copy of a table and puts the rows to be checked into it. PostgreSQL
 * refuses `CREATE TEMP TABLE` in a read-only transaction, so the transaction starts read-write, and
 * three things keep that from changing real data, with one limit. EVENT TRIGGERS fire on the
 * `CREATE TEMP TABLE` while the transaction is still read-write, and what one does can write; and an
 * effect outside this transaction (a `dblink` or foreign-table write from a CHECK function) is not undone by
 * the rollback. Neither is stopped here; both are accepted risks in `docs/threat-model.md`:
 *
 *  1. the only statements that run before the switch are `CREATE TEMP TABLE ... (LIKE ...)` and `ALTER`
 *     of that temporary table (built by `prepare`, from catalog names);
 *  2. then `SET TRANSACTION READ ONLY`, before any value is inserted. A temporary table can still be
 *     written in a read-only transaction, and everything else cannot: a CHECK constraint or a domain whose
 *     function tries to write a real table fails with SQLSTATE 25006 instead of writing;
 *  3. the transaction is ALWAYS rolled back, never committed, so even the temporary table goes away.
 *
 * As in `read-only.ts`, the timeouts are local to the transaction (`set_config(..., true)`), so they cannot
 * leak onto a pooled connection that is later reused.
 */
import type { Pool } from "pg";
import type { Queryable } from "./read-only.js";

/** How long the lock on the target table may be waited for (the copy only needs a share lock). */
const LOCK_TIMEOUT_MS = 2000;

export async function withCheckingTransaction<T>(
  pool: Pool,
  statementTimeoutMs: number,
  prepare: (db: Queryable) => Promise<void>,
  work: (db: Queryable) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let brokenConnection: Error | undefined;
  const db: Queryable = {
    query: async <Row>(text: string, values?: unknown[]) => {
      const { rows } = await client.query(text, values);
      return { rows: rows as Row[] };
    },
  };
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('statement_timeout', $1, true)", [
      String(statementTimeoutMs),
    ]);
    await client.query("SELECT set_config('lock_timeout', $1, true)", [String(LOCK_TIMEOUT_MS)]);
    await prepare(db);
    await client.query("SET TRANSACTION READ ONLY");
    return await work(db);
  } finally {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      brokenConnection =
        rollbackError instanceof Error ? rollbackError : new Error("rollback failed");
    }
    client.release(brokenConnection);
  }
}
