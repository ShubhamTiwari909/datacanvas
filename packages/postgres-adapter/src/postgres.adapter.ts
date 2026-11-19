/**
 * The PostgreSQL implementation of `DatabaseAdapter`.
 *
 * Responsibilities, in one place:
 *   - own the connection pool and its lifecycle,
 *   - run every query inside a read-only transaction (`withReadOnlyTransaction`),
 *   - translate every failure into a safe `DatabaseError` (`mapPgError`),
 *   - delegate the actual catalog queries to the `introspection/` modules.
 *
 * Apart from `getRows` (the opt-in data viewer, in `introspection/rows.ts`),
 * nothing here reads table rows, and there is no way to run caller-supplied
 * SQL: every query is a fixed string, or a fixed shape built from catalog
 * names, with bound parameters.
 *
 * It also implements the separate WRITE capability (`WritableAdapter`,
 * 1.4.0): a change is planned in a read-only transaction (`writes/`) and the
 * planned statements are then run exactly as planned in a read-write one
 * (`connection/write.ts`), with failures mapped to fixed messages
 * (`mapWriteError`). Only the server's write service reaches those methods.
 */
import {
  DatabaseError,
  ROW_CHANGE_TIMEOUT_MS,
  ROWS_SORT_FILTER_TIMEOUT_MS,
  SQL_LIMITS,
  SqlStatementError,
  checkStatementText,
  STRUCTURE_CHANGE_TIMEOUT_MS,
  WRITE_LOCK_TIMEOUT_MS,
  type AppliedChange,
  type Change,
  type PlannedChange,
  type TableEditInfo,
  type SqlRunRequest,
  type SqlRunResult,
  type SqlRunnerAdapter,
  type WritableAdapter,
  type ColumnInfo,
  type ConstraintInfo,
  type DatabaseAdapter,
  type DatabaseObjects,
  type DdlDetail,
  type IndexInfo,
  type IndexUsageReport,
  type RowPage,
  type RowsOptions,
  type RoleInfo,
  type RelationshipInfo,
  type SchemaInfo,
  type SearchHit,
  type TableDetailsEntry,
  type TableInfo,
  type TableRef,
} from "@datacanvas/database-core";
import type { ResolvedPostgresConnection } from "@datacanvas/shared-types";
import pg from "pg";
import {
  buildPoolConfig,
  resolveAdapterOptions,
  type PostgresAdapterOptions,
  type ResolvedAdapterOptions,
} from "./connection/config.js";
import { mapPgError } from "./connection/errors.js";
import { withReadOnlyTransaction, type Queryable } from "./connection/read-only.js";
import { mapWriteError } from "./connection/write-errors.js";
import { runStatementOnOwnConnection } from "./connection/run-statement.js";
import { withWriteTransaction } from "./connection/write.js";
import { listColumns } from "./introspection/columns.js";
import { loadTablesDetails } from "./introspection/details.js";
import { listConstraints } from "./introspection/constraints.js";
import { assertRelationExists, assertSchemaExists } from "./introspection/existence.js";
import { listIndexes } from "./introspection/indexes.js";
import { listIndexUsage } from "./introspection/index-usage.js";
import { readDdlDetail } from "./introspection/ddl-detail.js";
import { listObjects } from "./introspection/objects.js";
import { readRows } from "./introspection/rows.js";
import { listRelationships } from "./introspection/relationships.js";
import { readRoleInfo } from "./introspection/role-info.js";
import { listSchemas } from "./introspection/schemas.js";
import { searchObjects } from "./introspection/search.js";
import { listTables } from "./introspection/tables.js";
import { describeForEdit, planChange, runPlan } from "./writes/index.js";

export class PostgresAdapter implements DatabaseAdapter, WritableAdapter, SqlRunnerAdapter {
  private readonly connection: ResolvedPostgresConnection;
  private readonly options: ResolvedAdapterOptions;
  private pool: pg.Pool | undefined;
  /** Set while connect() is running, so two concurrent calls share one attempt. */
  private connecting: Promise<void> | undefined;

  constructor(connection: ResolvedPostgresConnection, options: PostgresAdapterOptions = {}) {
    this.connection = connection;
    this.options = resolveAdapterOptions(options);
  }

  connect(): Promise<void> {
    if (this.pool) return Promise.resolve();
    this.connecting ??= this.openPool().finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }

  private async openPool(): Promise<void> {
    const pool = new pg.Pool(buildPoolConfig(this.connection, this.options));
    // An idle connection can be dropped by the server at any time and the pool
    // reports that as an 'error' event. With no listener Node would treat it as
    // an uncaught exception and crash the whole process. The next query on the
    // pool will surface a real error, so ignoring the event here is safe.
    pool.on("error", () => {});
    try {
      // Prove the details work before declaring ourselves connected.
      await withReadOnlyTransaction(pool, this.options.statementTimeoutMs, (db) =>
        db.query("SELECT 1"),
      );
    } catch (error) {
      await pool.end().catch(() => {});
      throw mapPgError(error);
    }
    this.pool = pool;
  }

  async testConnection(): Promise<void> {
    // A single throwaway client, separate from the pool, so testing never
    // changes (or depends on) whether the adapter is "connected".
    const { ssl, ...rest } = buildPoolConfig(this.connection, this.options);
    const client = new pg.Client({ ...rest, ssl });
    client.on("error", () => {}); // same reason as the pool 'error' listener
    let opened = false;
    try {
      await client.connect();
      opened = true;
      await client.query("SELECT 1");
    } catch (error) {
      throw mapPgError(error);
    } finally {
      // Only end a client that actually connected; ending a failed one can hang.
      if (opened) await client.end().catch(() => {});
    }
  }

  async disconnect(): Promise<void> {
    const pool = this.pool;
    this.pool = undefined;
    if (pool) await pool.end().catch(() => {});
  }

  getSchemas(): Promise<SchemaInfo[]> {
    return this.read((db) => listSchemas(db));
  }

  getTables(schema: string): Promise<TableInfo[]> {
    return this.read(async (db) => {
      await assertSchemaExists(db, schema);
      return listTables(db, schema);
    });
  }

  getColumns(schema: string, table: string): Promise<ColumnInfo[]> {
    return this.read(async (db) => {
      await assertRelationExists(db, schema, table);
      return listColumns(db, schema, table);
    });
  }

  getConstraints(schema: string, table: string): Promise<ConstraintInfo[]> {
    return this.read(async (db) => {
      await assertRelationExists(db, schema, table);
      return listConstraints(db, schema, table);
    });
  }

  getIndexes(schema: string, table: string): Promise<IndexInfo[]> {
    return this.read(async (db) => {
      await assertRelationExists(db, schema, table);
      return listIndexes(db, schema, table);
    });
  }

  getTablesDetails(tables: TableRef[]): Promise<TableDetailsEntry[]> {
    return this.read((db) => loadTablesDetails(db, tables));
  }

  searchObjects(query: string, limit: number): Promise<SearchHit[]> {
    return this.read((db) => searchObjects(db, query, limit));
  }

  getRelationships(): Promise<RelationshipInfo[]> {
    return this.read((db) => listRelationships(db));
  }

  getDdlDetail(tables: readonly TableRef[], schemas: readonly string[]): Promise<DdlDetail> {
    return this.read((db) => readDdlDetail(db, tables, schemas));
  }

  getObjects(): Promise<DatabaseObjects> {
    return this.read((db) => listObjects(db));
  }

  async getRows(table: TableRef, options: RowsOptions): Promise<RowPage> {
    // A plain page keeps the usual statement timeout. A read with a sort or a filter runs under a shorter one
    // (never longer than the usual), and a read it stops is reported as too slow, not as a timeout.
    const limited =
      (options.sort !== undefined && options.sort !== null) || (options.filters?.length ?? 0) > 0;
    if (!limited) return this.read((db) => readRows(db, table, options));
    const limit = Math.min(ROWS_SORT_FILTER_TIMEOUT_MS, this.options.statementTimeoutMs);
    try {
      return await this.read((db) => readRows(db, table, options), limit);
    } catch (error) {
      if (error instanceof DatabaseError && error.code === "timeout" && wasCancelled(error.cause)) {
        throw new DatabaseError("too_slow", { cause: error.cause });
      }
      throw error;
    }
  }

  getIndexUsage(): Promise<IndexUsageReport> {
    return this.read((db) => listIndexUsage(db));
  }

  getRoleInfo(): Promise<RoleInfo> {
    return this.read((db) => readRoleInfo(db));
  }

  // ------------------------------------------------------------- writes ---
  // The write capability (WritableAdapter). Only the server's write service
  // calls these, after the start-up flag, the local rule and the unlock.

  describeForEdit(table: TableRef): Promise<TableEditInfo> {
    return this.read((db) => describeForEdit(db, table));
  }

  /** Check the change and build its statements in a READ-ONLY transaction: nothing changes. */
  previewChange(change: Change): Promise<PlannedChange> {
    return this.read((db) => planChange(db, change));
  }

  /** Run exactly the planned statements in one read-write transaction (decisions 127 and 128). */
  async applyChange(plan: PlannedChange): Promise<AppliedChange> {
    const pool = this.pool;
    if (!pool) throw new DatabaseError("not_connected");
    const statementTimeoutMs =
      plan.category === "row" ? ROW_CHANGE_TIMEOUT_MS : STRUCTURE_CHANGE_TIMEOUT_MS;
    try {
      return await withWriteTransaction(
        pool,
        { lockTimeoutMs: WRITE_LOCK_TIMEOUT_MS, statementTimeoutMs },
        (db) => runPlan(db, plan),
      );
    } catch (error) {
      throw mapWriteError(error);
    }
  }

  // ------------------------------------------------------------ SQL view ---
  // The SQL runner capability (SqlRunnerAdapter). Only the server's sql service calls it,
  // after the viewing switch. The first word is checked here as well, so the adapter is a
  // boundary on its own; the database's read-only transaction is what stops writes.

  async runStatement(request: SqlRunRequest): Promise<SqlRunResult> {
    if (!this.pool) throw new DatabaseError("not_connected");
    const check = checkStatementText(request.text);
    if (!check.ok) throw new SqlStatementError("not_allowed", check.message);
    const bounded: SqlRunRequest = {
      ...request,
      maxRows: Math.min(Math.max(1, Math.trunc(request.maxRows)), SQL_LIMITS.maxMaxRows),
      timeoutMs: Math.min(Math.max(100, Math.trunc(request.timeoutMs)), SQL_LIMITS.maxTimeoutMs),
    };
    try {
      return await runStatementOnOwnConnection(
        buildPoolConfig(this.connection, this.options),
        bounded,
      );
    } catch (error) {
      if (error instanceof SqlStatementError) throw error;
      throw mapPgError(error);
    }
  }

  /** Run `work` in a read-only transaction and translate any failure to a DatabaseError. */
  private async read<T>(
    work: (db: Queryable) => Promise<T>,
    statementTimeoutMs: number = this.options.statementTimeoutMs,
  ): Promise<T> {
    const pool = this.pool;
    if (!pool) throw new DatabaseError("not_connected");
    try {
      return await withReadOnlyTransaction(pool, statementTimeoutMs, work);
    } catch (error) {
      throw mapPgError(error); // returns DatabaseErrors (such as not_found) unchanged
    }
  }
}

/** Did the server cancel the statement (SQLSTATE 57014: our statement timeout fired), as opposed to a connection that timed out? */
function wasCancelled(cause: unknown): boolean {
  return (
    typeof cause === "object" && cause !== null && (cause as { code?: unknown }).code === "57014"
  );
}

/** Factory in the shape `AdapterRegistry.register("postgresql", ...)` expects. */
export function createPostgresAdapter(connection: ResolvedPostgresConnection): PostgresAdapter {
  return new PostgresAdapter(connection);
}
