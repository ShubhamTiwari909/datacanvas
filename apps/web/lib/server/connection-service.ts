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
  buildStructure,
  OBJECT_KINDS,
  type AdapterRegistry,
  type ColumnInfo,
  type ConstraintInfo,
  type DatabaseObjects,
  type IndexInfo,
  type IndexUsageReport,
  type RelationshipInfo,
  type RoleInfo,
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

  constructor(dependencies: ConnectionServiceDependencies) {
    this.adapters = dependencies.adapters;
    this.connections = dependencies.connections;
    this.profiles = dependencies.profiles;
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
      const schemas = (await adapter.getSchemas()).map((s) => s.name);
      // A few schemas at a time: a database with one schema per tenant must not send hundreds
      // of queries at once (that could exhaust the connection pool).
      const lists: TableInfo[][] = [];
      for (let start = 0; start < schemas.length; start += SCHEMA_BATCH) {
        lists.push(
          ...(await Promise.all(
            schemas.slice(start, start + SCHEMA_BATCH).map((schema) => adapter.getTables(schema)),
          )),
        );
      }
      const refs = lists.flat().map((t): TableRef => ({ schema: t.schema, name: t.name }));
      if (refs.length > MAX_SNAPSHOT_TABLES) {
        throw new ServiceError(
          "snapshot_too_large",
          `This database has ${refs.length} tables; a snapshot holds at most ${MAX_SNAPSHOT_TABLES}.`,
        );
      }
      const entries: TableDetailsEntry[] = [];
      for (let start = 0; start < refs.length; start += MAX_TABLES_PER_DETAILS_REQUEST) {
        entries.push(
          ...(await adapter.getTablesDetails(
            refs.slice(start, start + MAX_TABLES_PER_DETAILS_REQUEST),
          )),
        );
      }
      const relationships = await adapter.getRelationships();
      const objects = await adapter.getObjects();
      const tooMany = OBJECT_KINDS.find(
        (kind) => objects[kind].length > MAX_SNAPSHOT_OBJECTS_PER_KIND,
      );
      if (tooMany !== undefined) {
        throw new ServiceError(
          "snapshot_too_large",
          `This database has ${objects[tooMany].length} objects of one kind (${tooMany}); a snapshot holds at most ${MAX_SNAPSHOT_OBJECTS_PER_KIND} of each kind.`,
        );
      }
      return {
        structure: buildStructure(schemas, entries, relationships, objects),
        source: { connectionName: summary.name, database: summary.database },
      };
    });
  }
}
