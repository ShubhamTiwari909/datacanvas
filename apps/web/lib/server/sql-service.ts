/**
 * Running a statement the person typed (1.6.0, decision 141): the ONLY place in the
 * app that reaches an adapter's SQL runner (`SqlRunnerAdapter`). A rule in
 * tests/architecture.test.ts fails if any other app file does.
 *
 * Every run needs, checked here in this order:
 *   1. the connection exists,
 *   2. viewing table data is on for it (a result is rows, like the Data tab),
 *   3. the text is one statement that starts with an allowed word,
 *   4. no other statement is running on the connection (`sql_busy`).
 * Writing is not possible through here, even with `--enable-writes`: the adapter runs the
 * text in a read-only transaction on a connection of its own.
 *
 * PRIVACY: the text and the rows of a result are never logged, kept or put in an error of
 * ours. The database's own refusal of a statement (its sentence and position) is returned
 * to the person who typed it, as the answer to that request. Nothing here writes to a log:
 * a rule in tests/security.test.ts fails if a file of the SQL path does.
 */
import {
  checkStatementText,
  DatabaseError,
  isSqlRunnerAdapter,
  SQL_LIMITS,
  SqlStatementError,
  type SqlRunResult,
} from "@datacanvas/database-core";
import type { SqlFailure, SqlRunRequest } from "@datacanvas/shared-types";
import type { ConnectionRegistry } from "./connection-registry";
import { ServiceError } from "./service-error";

export const SQL_MESSAGES = {
  connectionNotFound: "This connection does not exist.",
  dataAccessOff:
    "Running SQL shows rows, so it needs viewing table data to be on for this connection. Switch it on first.",
  busy: "Another statement is still running on this connection. Wait for it, or cancel it.",
  notSupported: "This kind of database cannot run SQL here.",
} as const;

export type SqlRunOutcome = { result: SqlRunResult } | { failure: SqlFailure };

export class SqlService {
  private readonly connections: ConnectionRegistry;
  /** The statement running on each connection, so it can be cancelled and so only one runs. */
  private readonly running = new Map<string, AbortController>();

  constructor(dependencies: { connections: ConnectionRegistry }) {
    this.connections = dependencies.connections;
    // A disconnect cancels what was running on the connection.
    this.connections.onRemove((id) => this.running.get(id)?.abort());
  }

  /**
   * Run one statement read-only. A statement the database refused or stopped is an
   * OUTCOME (`failure`), not an exception: it is the answer to what the person typed.
   * @throws ServiceError `connection_not_found`, `data_access_disabled`, `sql_busy`;
   *   DatabaseError for the connection (`not_connected`, `unreachable`, `not_supported`, ...).
   */
  async run(
    id: string,
    request: SqlRunRequest,
    clientSignal?: AbortSignal,
  ): Promise<SqlRunOutcome> {
    const summary = this.connections.getSummary(id);
    if (!summary) throw new ServiceError("connection_not_found", SQL_MESSAGES.connectionNotFound);
    if (!summary.dataAccess) {
      throw new ServiceError("data_access_disabled", SQL_MESSAGES.dataAccessOff);
    }
    const check = checkStatementText(request.text);
    if (!check.ok)
      return { failure: { code: "not_allowed", message: check.message, position: null } };
    if (this.running.has(id)) throw new ServiceError("sql_busy", SQL_MESSAGES.busy);

    const controller = new AbortController();
    this.running.set(id, controller);
    // The browser going away (a closed tab, a Cancel) cancels the statement in the database.
    const abort = (): void => controller.abort();
    clientSignal?.addEventListener("abort", abort, { once: true });
    if (clientSignal?.aborted) abort();
    try {
      const result = await this.connections.use(id, (adapter) => {
        if (!isSqlRunnerAdapter(adapter)) {
          throw new DatabaseError("not_supported", { message: SQL_MESSAGES.notSupported });
        }
        return adapter.runStatement({
          text: request.text,
          maxRows: Math.min(request.maxRows, SQL_LIMITS.maxMaxRows),
          timeoutMs: Math.min(request.timeoutMs, SQL_LIMITS.maxTimeoutMs),
          signal: controller.signal,
        });
      });
      return { result };
    } catch (error) {
      if (error instanceof SqlStatementError) {
        return { failure: { code: error.code, message: error.message, position: error.position } };
      }
      throw error;
    } finally {
      clientSignal?.removeEventListener("abort", abort);
      if (this.running.get(id) === controller) this.running.delete(id);
    }
  }
}
