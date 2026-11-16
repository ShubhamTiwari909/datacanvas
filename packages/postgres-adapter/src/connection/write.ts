/**
 * Run work inside a READ-WRITE transaction: the only place this adapter can
 * change a database (1.4.0, `docs/data-editing-plan.md` section 6.3).
 *
 * - It takes its own client from the pool for the whole transaction; it never
 *   reuses a read-only session and a read-only session never reuses it in the
 *   middle of a change.
 * - `lock_timeout` is short, so a change that would wait behind another
 *   session's lock fails fast instead of queueing (and blocking every query
 *   that arrives after it). `statement_timeout` bounds the work itself. Both
 *   are set with `set_config(..., true)`: local to this transaction, so they
 *   cannot leak onto the pooled connection.
 * - It is a plain `BEGIN`, not `BEGIN READ WRITE`: a database whose owner made
 *   it read-only by default (`default_transaction_read_only`) stays read-only.
 * - Any error, including a failed assertion in `work`, rolls everything back.
 *   If the ROLLBACK itself fails, the connection is destroyed, not reused.
 */
import type { Pool } from "pg";

/** The part of a client the write path needs: a statement and how many rows it touched. */
export interface WriteClient {
  query(text: string, values?: readonly unknown[]): Promise<{ rowCount: number | null }>;
}

export interface WriteLimits {
  lockTimeoutMs: number;
  statementTimeoutMs: number;
}

export async function withWriteTransaction<T>(
  pool: Pool,
  limits: WriteLimits,
  work: (db: WriteClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let brokenConnection: Error | undefined;
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('lock_timeout', $1, true), set_config('statement_timeout', $2, true)",
      [String(limits.lockTimeoutMs), String(limits.statementTimeoutMs)],
    );
    const result = await work({
      query: async (text, values) => {
        const outcome = await client.query(text, values as unknown[] | undefined);
        return { rowCount: outcome.rowCount };
      },
    });
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      brokenConnection =
        rollbackError instanceof Error ? rollbackError : new Error("rollback failed");
    }
    throw error;
  } finally {
    client.release(brokenConnection);
  }
}
