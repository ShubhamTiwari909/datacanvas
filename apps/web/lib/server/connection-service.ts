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
import type {
  AdapterRegistry,
  ColumnInfo,
  ConstraintInfo,
  IndexInfo,
  RelationshipInfo,
  SchemaInfo,
  SearchHit,
  TableDetailsEntry,
  TableInfo,
  TableRef,
} from "@datacanvas/database-core";
import {
  resolvePostgresConnection,
  summarizePostgresConnection,
  type ConnectionSummary,
  type PostgresConnectionInput,
  type ResolvedPostgresConnection,
} from "@datacanvas/shared-types";
import type { ConnectionRegistry } from "./connection-registry";
import type { ProfileService } from "./profile-service";
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
  };
}

export class ConnectionService {
  private readonly adapters: AdapterRegistry<ProviderConfigs>;
  private readonly connections: ConnectionRegistry;
  private readonly profiles: ProfileService;

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
    let profileId: string | null = input.profileId
      ? (await this.profiles.get(input.profileId)).id
      : null;

    const adapter = this.adapters.create("postgresql", resolved);
    await adapter.connect(); // throws DatabaseError on failure: nothing registered yet
    try {
      // The summary has no password; the password stays inside `adapter`.
      const details = { ...summarizePostgresConnection(resolved), provider: "postgresql" as const };
      if (profileId === null && input.remember) {
        profileId = (await this.profiles.add(profileDetails(details))).id;
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

  /** Called when a saved profile is forgotten, so no live connection keeps pointing at it. */
  unlinkProfile(profileId: string): void {
    this.connections.clearProfile(profileId);
  }

  listConnections(): ConnectionSummary[] {
    return this.connections.list();
  }

  /** Disconnect and forget a connection (and its credentials). */
  deleteConnection(id: string): Promise<void> {
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
}
