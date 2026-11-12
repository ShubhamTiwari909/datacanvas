/**
 * Run work inside a READ ONLY transaction with a statement timeout.
 *
 * Why a transaction per operation rather than session settings:
 *  - `BEGIN READ ONLY` makes the DATABASE SERVER refuse any write, so even a
 *    bug in our code could not modify the user's data.
 *  - It works through connection poolers (PgBouncer and similar, which reject
 *    startup parameters such as `options=-c default_transaction_read_only=on`),
 *    because everything happens inside one transaction on one connection.
 *  - `set_config(..., true)` is local to the transaction, so the timeout
 *    cannot leak onto a pooled connection that is later reused.
 */
import type { Pool } from "pg";

/** The tiny part of a database client that introspection queries need. */
export interface Queryable {
  query<Row = Record<string, unknown>>(text: string, values?: unknown[]): Promise<{ rows: Row[] }>;
}

export async function withReadOnlyTransaction<T>(
  pool: Pool,
  statementTimeoutMs: number,
  work: (db: Queryable) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  // If ROLLBACK itself fails the connection is broken; passing the error to
  // release() tells the pool to destroy it instead of reusing it.
  let brokenConnection: Error | undefined;
  try {
    await client.query("BEGIN READ ONLY");
    // Parameterised (SET itself cannot take parameters); `true` = local to this transaction.
    await client.query("SELECT set_config('statement_timeout', $1, true)", [
      String(statementTimeoutMs),
    ]);
    const result = await work({
      query: async <Row>(text: string, values?: unknown[]) => {
        const { rows } = await client.query(text, values);
        return { rows: rows as Row[] };
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
