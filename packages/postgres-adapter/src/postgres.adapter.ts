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
 */
import {
  DatabaseError,
  ROWS_SORT_FILTER_TIMEOUT_MS,
  type ColumnInfo,
  type ConstraintInfo,
  type DatabaseAdapter,
  type DatabaseObjects,
  type IndexInfo,
  type IndexUsageReport,
  type RowPage,
  type RowsOptions,
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
import { listColumns } from "./introspection/columns.js";
import { loadTablesDetails } from "./introspection/details.js";
import { listConstraints } from "./introspection/constraints.js";
import { assertRelationExists, assertSchemaExists } from "./introspection/existence.js";
import { listIndexes } from "./introspection/indexes.js";
import { listIndexUsage } from "./introspection/index-usage.js";
import { listObjects } from "./introspection/objects.js";
import { readRows } from "./introspection/rows.js";
import { listRelationships } from "./introspection/relationships.js";
import { listSchemas } from "./introspection/schemas.js";
import { searchObjects } from "./introspection/search.js";
import { listTables } from "./introspection/tables.js";

export class PostgresAdapter implements DatabaseAdapter {
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

  getObjects(): Promise<DatabaseObjects> {
    return this.read((db) => listObjects(db));
  }

  async getRows(table: TableRef, options: RowsOptions): Promise<RowPage> {
    // A plain page keeps the usual statement timeout. A read with a sort runs under a shorter one
    // (never longer than the usual), and a read it stops is reported as too slow, not as a timeout.
    if (options.sort === undefined || options.sort === null) {
      return this.read((db) => readRows(db, table, options));
    }
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
