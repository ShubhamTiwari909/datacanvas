/**
 * Application logic for connections and for exploring them.
 *
 * Route handlers stay thin (validate input, call one of these methods, return
 * JSON); everything that decides WHAT happens lives here. The service gets its
 * collaborators through the constructor ("dependency injection"), so tests
 * can give it mock adapters instead of a real database.
 *
 * This file knows nothing about PostgreSQL or HTTP: it speaks only the
 * `DatabaseAdapter` interface and plain data.
 */
import {
  captureStructure,
  StructureTooLargeError,
  type AdapterRegistry,
  type ColumnInfo,
  type ConstraintInfo,
  type DatabaseObjects,
  type IndexInfo,
  type IndexUsageReport,
  type RelationshipInfo,
  type RoleInfo,
  type CellRead,
  EXPORT_MAX_BYTES,
  createFormatter,
  EXPORT_MEDIA,
  type PreflightResult,
  type ValidationReport,
  type RowPage,
  type SchemaInfo,
  type SearchHit,
  type DatabaseStructure,
  type TableDetailsEntry,
  type TableInfo,
  type TableRef,
} from "@datacanvas/database-core";
import {
  MAX_SNAPSHOT_OBJECTS_PER_KIND,
  MAX_SNAPSHOT_TABLES,
  MAX_TABLES_PER_DETAILS_REQUEST,
  resolvePostgresConnection,
  summarizePostgresConnection,
  type ConnectionSummary,
  type ParsedCellRequest,
  type ParsedExportRequest,
  type ParsedPreflightRequest,
  type ParsedValidateRequest,
  type ParsedRowsRequest,
  type SnapshotSource,
  type PostgresConnectionInput,
  type ResolvedPostgresConnection,
} from "@datacanvas/shared-types";
import type { ConnectionRegistry } from "./connection-registry";
import type { ProfileService } from "./profile-service";
import { RowsGate } from "./rows-gate";
import { ServiceError } from "./service-error";

/** Connection details each provider needs. Only PostgreSQL for now. */
export type ProviderConfigs = { postgresql: ResolvedPostgresConnection };

export interface ConnectionServiceDependencies {
  adapters: AdapterRegistry<ProviderConfigs>;
  connections: ConnectionRegistry;
  profiles: ProfileService;
  /** How long a write to the browser may wait before an export is given up (a reader that stopped). Default one minute. */
  exportStallMs?: number;
}

export interface TableDetails {
  columns: ColumnInfo[];
  constraints: ConstraintInfo[];
  indexes: IndexInfo[];
}

/** The non-secret fields that make up a saved profile. */
function profileDetails(
  summary: Omit<ConnectionSummary, "id" | "profileId" | "hasPassword"> & { hasPassword?: boolean },
) {
  return {
    provider: summary.provider,
    name: summary.name,
    host: summary.host,
    port: summary.port,
    database: summary.database,
    username: summary.username,
    sslMode: summary.sslMode,
    dataAccess: summary.dataAccess,
  };
}

/** How many schemas have their tables listed at the same time when a snapshot is taken. */
const SCHEMA_BATCH = 8;

export class ConnectionService {
  private readonly adapters: AdapterRegistry<ProviderConfigs>;
  private readonly connections: ConnectionRegistry;
  private readonly profiles: ProfileService;
  /** Row reads, one page at a time per connection. */
  private readonly rowsGate = new RowsGate();
  /** Connections with an export running: one at a time each. */
  private readonly exporting = new Set<string>();
  private readonly exportStallMs: number;

  constructor(dependencies: ConnectionServiceDependencies) {
    this.adapters = dependencies.adapters;
    this.connections = dependencies.connections;
    this.profiles = dependencies.profiles;
    this.exportStallMs = dependencies.exportStallMs ?? 60_000;
  }

  /** Close every database session and forget all credentials. Used when the server shuts down. */
  async dispose(): Promise<void> {
    await this.connections.dispose();
  }

  /**
   * Check that the details work, without remembering anything. Throws a
   * `DatabaseError` describing what is wrong if they do not.
   */
  async testConnection(input: PostgresConnectionInput): Promise<void> {
    const adapter = this.adapters.create("postgresql", resolvePostgresConnection(input));
    await adapter.testConnection();
  }

  /**
   * Connect for real and remember the connection (in memory). If connecting
   * fails, or the registry is full, nothing is stored (and nothing stays open).
   *
   * Saving: `input.profileId` links the connection to an EXISTING saved profile
   * (reconnecting after a restart); otherwise `input.remember` saves a new
   * profile from the connection's non-secret details. Either way the password
   * is never written anywhere.
   */
  async createConnection(input: PostgresConnectionInput): Promise<ConnectionSummary> {
    const resolved = resolvePostgresConnection(input);
    // Cheap check first: do not open a database connection for a profile that is gone.
    const linked = input.profileId ? await this.profiles.get(input.profileId) : null;
    let profileId: string | null = linked?.id ?? null;
    // Viewing table data is off unless asked for; a reconnected profile brings its own setting back.
    const dataAccess = input.dataAccess ?? linked?.dataAccess ?? false;

    const adapter = this.adapters.create("postgresql", resolved);
    await adapter.connect(); // throws DatabaseError on failure: nothing registered yet
    try {
      // The summary has no password; the password stays inside `adapter`.
      const details = {
        ...summarizePostgresConnection(resolved, dataAccess),
        provider: "postgresql" as const,
      };
      if (profileId === null && input.remember) {
        const saved = await this.profiles.add(profileDetails(details));
        profileId = saved.id;
        // The same database may already be saved: keep the choice just made.
        if (saved.dataAccess !== dataAccess)
          await this.profiles.setDataAccess(saved.id, dataAccess);
      } else if (linked && input.dataAccess !== undefined && linked.dataAccess !== dataAccess) {
        await this.profiles.setDataAccess(linked.id, dataAccess);
      }
      return this.connections.add({ ...details, profileId }, adapter);
    } catch (error) {
      await adapter.disconnect(); // e.g. the registry is full: do not leave a connection open
      throw error;
    }
  }

  /**
   * Save a live connection's non-secret details as a profile ("Save connection"
   * for a connection that was opened without remembering it).
   * @throws ServiceError `connection_not_found`
   */
  async saveConnection(id: string): Promise<ConnectionSummary> {
    const summary = this.connections.getSummary(id);
    if (!summary) throw new ServiceError("connection_not_found", "This connection does not exist.");
    if (summary.profileId !== null) return summary;

    const profile = await this.profiles.add(profileDetails(summary));
    return this.connections.setProfileId(id, profile.id);
  }

  /**
   * Switch viewing table data on or off for a live connection, and remember the
   * choice with its saved profile, if it has one.
   * @throws ServiceError `connection_not_found`
   */
  async setDataAccess(id: string, enabled: boolean): Promise<ConnectionSummary> {
    const summary = this.connections.getSummary(id);
    if (!summary) throw new ServiceError("connection_not_found", "This connection does not exist.");
    // The saved copy first: if the disk fails, nothing changed.
    if (summary.profileId !== null) await this.profiles.setDataAccess(summary.profileId, enabled);
    return this.connections.setDataAccess(id, enabled);
  }

  /**
   * One page of a table's ROWS. The only place rows are read for the browser, and
   * it refuses unless viewing table data is switched on for this connection: that
   * check comes first, before the database is touched.
   *
   * @throws ServiceError `connection_not_found`, `data_access_disabled`, `rows_busy`;
   *   DatabaseError `not_found`, `not_supported`, `invalid_request`, `permission_denied`, ...
   */
  getRows(id: string, request: ParsedRowsRequest): Promise<RowPage> {
    const summary = this.connections.getSummary(id);
    if (!summary) {
      return Promise.reject(
        new ServiceError("connection_not_found", "This connection does not exist."),
      );
    }
    if (!summary.dataAccess) {
      return Promise.reject(
        new ServiceError(
          "data_access_disabled",
          "Viewing table data is switched off for this connection. Switch it on to see rows.",
        ),
      );
    }
    return this.rowsGate.run(id, () =>
      this.connections.use(id, (adapter) =>
        adapter.getRows(
          { schema: request.schema, name: request.table },
          {
            pageSize: request.pageSize,
            cursor: request.cursor,
            revealColumns: request.revealColumns,
            sort: request.sort,
            filters: request.filters,
          },
        ),
      ),
    );
  }

  /**
   * ONE `json` or `jsonb` value of one row, whole, for the JSON editor. Table data, so the same rule as
   * `getRows`: refused unless viewing table data is switched on, and that check comes first.
   *
   * @throws ServiceError `connection_not_found`, `data_access_disabled`, `rows_busy`;
   *   DatabaseError `not_found`, `not_supported`, `invalid_request`, `permission_denied`, ...
   */
  getCell(id: string, request: ParsedCellRequest): Promise<CellRead> {
    const summary = this.connections.getSummary(id);
    if (!summary) {
      return Promise.reject(
        new ServiceError("connection_not_found", "This connection does not exist."),
      );
    }
    if (!summary.dataAccess) {
      return Promise.reject(
        new ServiceError(
          "data_access_disabled",
          "Viewing table data is switched off for this connection. Switch it on to see rows.",
        ),
      );
    }
    return this.rowsGate.run(id, () =>
      this.connections.use(id, (adapter) =>
        adapter.getCell(
          { schema: request.schema, name: request.table },
          { column: request.column, key: request.key, revealColumns: request.revealColumns },
        ),
      ),
    );
  }

  /**
   * Would the database accept these values? Answered without writing a row (decision 157). It asks the
   * database whether values of a table collide with its rows, so it is table data like a page of rows: the
   * same rule, refused unless viewing table data is switched on, and that check comes first. It does not
   * need writes to be unlocked: it changes nothing.
   *
   * @throws ServiceError `connection_not_found`, `data_access_disabled`, `rows_busy`;
   *   DatabaseError `invalid_request`, `not_found`, `not_supported`, `permission_denied`, `timeout`, ...
   */
  validateRows(id: string, request: ParsedValidateRequest): Promise<ValidationReport> {
    const summary = this.connections.getSummary(id);
    if (!summary) {
      return Promise.reject(
        new ServiceError("connection_not_found", "This connection does not exist."),
      );
    }
    if (!summary.dataAccess) {
      return Promise.reject(
        new ServiceError(
          "data_access_disabled",
          "Viewing table data is switched off for this connection. Switch it on to see rows.",
        ),
      );
    }
    return this.rowsGate.run(id, () =>
      this.connections.use(id, (adapter) =>
        adapter.validateRows({
          table: { schema: request.schema, name: request.table },
          mode: request.mode,
          columns: request.columns,
          rows: request.rows,
          ...(request.key ? { key: request.key } : {}),
        }),
      ),
    );
  }

  /**
   * How many rows would make steps of a migration fail, in the database of this connection (the pre-flight of
   * the Migrations tab; decision 157). Only counts come back, but a count says how the data is, so it is table
   * data like a page of rows: the same rule, the data-access check first, the same gate.
   *
   * @throws ServiceError `connection_not_found`, `data_access_disabled`, `rows_busy`;
   *   DatabaseError `invalid_request`, `permission_denied`, ...
   */
  preflight(id: string, request: ParsedPreflightRequest): Promise<PreflightResult[]> {
    const summary = this.connections.getSummary(id);
    if (!summary) {
      return Promise.reject(
        new ServiceError("connection_not_found", "This connection does not exist."),
      );
    }
    if (!summary.dataAccess) {
      return Promise.reject(
        new ServiceError(
          "data_access_disabled",
          "Viewing table data is switched off for this connection. Switch it on to see rows.",
        ),
      );
    }
    return this.rowsGate.run(id, () =>
      this.connections.use(id, (adapter) => adapter.preflight(request.checks)),
    );
  }

  /**
   * The rows of a table as a file, streamed (decision 158). Table data, so the same rule as `getRows`: refused
   * unless viewing table data is switched on, and that check comes first. One export at a time per connection.
   * The answer is a stream of text: the file is built a batch at a time and let go, up to `EXPORT_MAX_ROWS` rows
   * and `EXPORT_MAX_BYTES`, after which it ends with a line that says it was cut. A client that goes away (or
   * `signal` aborting) ends the read and rolls its transaction back. Errors about the request come before the
   * first byte, so the route can still answer them; one after that ends the stream.
   *
   * @throws ServiceError `connection_not_found`, `data_access_disabled`, `export_busy`;
   *   DatabaseError `invalid_request`, `not_found`, `permission_denied`, ...
   */
  async exportRows(
    id: string,
    request: ParsedExportRequest,
    signal?: AbortSignal,
  ): Promise<{ stream: ReadableStream<Uint8Array>; contentType: string }> {
    const summary = this.connections.getSummary(id);
    if (!summary) throw new ServiceError("connection_not_found", "This connection does not exist.");
    if (!summary.dataAccess) {
      throw new ServiceError(
        "data_access_disabled",
        "Viewing table data is switched off for this connection. Switch it on to see rows.",
      );
    }
    if (this.exporting.has(id)) {
      throw new ServiceError("export_busy", "An export is already running on this connection.");
    }
    this.exporting.add(id);
    const table = { schema: request.schema, name: request.table };
    const formatter = createFormatter(
      {
        format: request.format,
        delimiter: request.delimiter,
        header: request.header,
        nullText: request.nullText,
        meta: request.meta,
      },
      {
        table,
        at: new Date(),
        // The conditions in words that name no value.
        filters: request.filters.map((f) => `${f.column} ${f.op.replace(/_/g, " ")}`),
      },
    );
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();
    let bytes = 0;
    let leftOut: string[] = [];
    /** The rows actually written, and whether a batch was left out for the size limit. */
    let rowsWritten = 0;
    let refused = false;
    /** Write a piece; false when the file has reached its size limit. */
    const write = async (text: string, limited = false): Promise<boolean> => {
      if (text === "") return true;
      const chunk = encoder.encode(text);
      // A batch of rows that would pass the limit is left out whole, so the file never grows past it by a batch.
      // The first batch is always written: a file with a header and no rows would say nothing about the table.
      if (limited && rowsWritten > 0 && bytes + chunk.byteLength > EXPORT_MAX_BYTES) {
        refused = true;
        return false;
      }
      bytes += chunk.byteLength;
      // A write waits for the reader of the stream. A reader that stopped (a closed laptop, a stalled socket) would
      // hold the connection, its transaction and the one export slot for ever: after a minute it is given up.
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          writer.write(chunk),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
              () => reject(new Error("The export stopped: the browser stopped receiving.")),
              this.exportStallMs,
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
      return bytes < EXPORT_MAX_BYTES;
    };
    let began!: () => void;
    let failedFirst!: (error: unknown) => void;
    const first = new Promise<void>((resolve, reject) => {
      began = resolve;
      failedFirst = reject;
    });
    let started = false;
    void this.connections
      .use(id, (adapter) =>
        adapter.exportRows(
          table,
          { revealColumns: request.revealColumns, sort: request.sort, filters: request.filters },
          async (event) => {
            if (event.kind === "start") {
              started = true;
              leftOut = event.leftOut;
              // Answer before the first write: a write waits for the reader of the stream.
              began();
              // Spreadsheets guess the encoding of a CSV file from a byte order mark.
              await write(
                (request.format === "csv" ? "\uFEFF" : "") +
                  formatter.start(event.columns, leftOut),
              );
              return undefined;
            }
            if (event.kind === "rows") {
              const more = await write(formatter.rows(event.rows), true);
              if (!refused) rowsWritten += event.rows.length;
              return more;
            }
            // The end note counts what the file holds, and says "bytes" when a batch was left out for the limit.
            await write(
              formatter.end({
                ...event,
                rows: rowsWritten,
                cut: refused ? "bytes" : event.cut,
                leftOut,
              }),
            );
            return undefined;
          },
          signal,
        ),
      )
      .then(
        () => {
          // An export that ended before it began (the request was already cancelled) must not leave the caller waiting.
          began();
          // The read is over: the slot is free now, while the browser may still be draining what was written.
          void writer.close().catch(() => undefined);
        },
        (error: unknown) => {
          if (!started) failedFirst(error);
          // What ends the stream after the first byte reaches the server's own log through the framework: it is a
          // fixed sentence, never the error of the database (whose message can hold a value) or its cause.
          void writer
            .abort(new Error("The export stopped before the end of the file."))
            .catch(() => undefined);
        },
      )
      .catch(() => undefined)
      .finally(() => {
        this.exporting.delete(id);
      });
    await first;
    return { stream: readable, contentType: EXPORT_MEDIA[request.format].type };
  }

  /** Called when a saved profile is forgotten, so no live connection keeps pointing at it. */
  unlinkProfile(profileId: string): void {
    this.connections.clearProfile(profileId);
  }

  listConnections(): ConnectionSummary[] {
    return this.connections.list();
  }

  /** Disconnect and forget a connection (and its credentials). */
  deleteConnection(id: string): Promise<void> {
    this.rowsGate.forget(id);
    return this.connections.remove(id);
  }

  getSchemas(id: string): Promise<SchemaInfo[]> {
    return this.connections.use(id, (adapter) => adapter.getSchemas());
  }

  getTables(id: string, schema: string): Promise<TableInfo[]> {
    return this.connections.use(id, (adapter) => adapter.getTables(schema));
  }

  /** Columns, constraints and indexes of one table, fetched together. */
  getTableDetails(id: string, schema: string, table: string): Promise<TableDetails> {
    return this.connections.use(id, async (adapter) => {
      const [columns, constraints, indexes] = await Promise.all([
        adapter.getColumns(schema, table),
        adapter.getConstraints(schema, table),
        adapter.getIndexes(schema, table),
      ]);
      return { columns, constraints, indexes };
    });
  }

  /** Many tables in one go (used by the canvas). One call to the database, however many tables. */
  getTablesDetails(id: string, tables: TableRef[]): Promise<TableDetailsEntry[]> {
    return this.connections.use(id, (adapter) => adapter.getTablesDetails(tables));
  }

  /** Search table, view and column names across the whole database. */
  search(id: string, query: string, limit: number): Promise<SearchHit[]> {
    return this.connections.use(id, (adapter) => adapter.searchObjects(query, limit));
  }

  getRelationships(id: string): Promise<RelationshipInfo[]> {
    return this.connections.use(id, (adapter) => adapter.getRelationships());
  }

  /** Usage counters of the indexes (statistics, not rows). */
  getIndexUsage(id: string): Promise<IndexUsageReport> {
    return this.connections.use(id, (adapter) => adapter.getIndexUsage());
  }

  /** What the connected role can do, and the server's address (catalog only, read-only). */
  getRoleInfo(id: string): Promise<RoleInfo> {
    return this.connections.use(id, (adapter) => adapter.getRoleInfo());
  }

  /** Views, types, sequences, functions, triggers, extensions and policies of the database. */
  getObjects(id: string): Promise<DatabaseObjects> {
    return this.connections.use(id, (adapter) => adapter.getObjects());
  }

  /**
   * Read the whole structure of a database: every schema, table, column,
   * constraint, index and foreign key (never rows). Used for snapshots and for
   * comparing a live database with one.
   *
   * @throws ServiceError `snapshot_too_large` when there are more tables than a snapshot may hold.
   */
  captureStructure(id: string): Promise<{ structure: DatabaseStructure; source: SnapshotSource }> {
    const summary = this.connections.getSummary(id);
    if (!summary) {
      return Promise.reject(
        new ServiceError("connection_not_found", "This connection does not exist."),
      );
    }
    return this.connections.use(id, async (adapter) => {
      try {
        const structure = await captureStructure(adapter, {
          maxTables: MAX_SNAPSHOT_TABLES,
          maxObjectsPerKind: MAX_SNAPSHOT_OBJECTS_PER_KIND,
          schemaBatch: SCHEMA_BATCH,
          detailsBatch: MAX_TABLES_PER_DETAILS_REQUEST,
        });
        return {
          structure,
          source: { connectionName: summary.name, database: summary.database },
        };
      } catch (error) {
        if (error instanceof StructureTooLargeError) {
          throw new ServiceError(
            "snapshot_too_large",
            error.what === "tables"
              ? `This database has ${error.count} tables; a snapshot holds at most ${MAX_SNAPSHOT_TABLES}.`
              : `This database has ${error.count} objects of one kind (${error.what}); a snapshot holds at most ${MAX_SNAPSHOT_OBJECTS_PER_KIND} of each kind.`,
          );
        }
        throw error;
      }
    });
  }
}
