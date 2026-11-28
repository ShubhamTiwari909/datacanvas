/**
 * The server-side "composition root": builds the long-lived objects the route
 * handlers share and hands them out. Route handlers call `getServerContext()`
 * instead of creating their own services.
 *
 * WHY globalThis: in development Next.js re-evaluates a module every time its
 * code changes (hot reload), which would create a fresh, empty registry and
 * orphan every open connection (and its database pool). Objects stored on
 * `globalThis` survive those reloads. In production it simply means "exactly
 * one instance per process".
 */
import { AdapterRegistry } from "@datacanvas/database-core";
import { createPostgresAdapter } from "@datacanvas/postgres-adapter";
import { ConnectionRegistry } from "./connection-registry";
import { ConnectionService, type ProviderConfigs } from "./connection-service";
import { ProfileService } from "./profile-service";
import { ProfileStorage } from "./storage/profile-storage";
import { resolveDataDir } from "./storage/data-dir";
import { SnapshotStorage } from "./storage/snapshot-storage";
import { WorkspaceStorage } from "./storage/workspace-storage";
import { SnapshotService } from "./snapshot-service";
import { McpService } from "./mcp-service";
import { SavedQueryService } from "./saved-query-service";
import { SqlService } from "./sql-service";
import { WorkspaceService } from "./workspace-service";
import { WriteService } from "./write-service";
import { readSecurityConfig } from "../security/request-guard";

export interface ServerContext {
  connections: ConnectionService;
  profiles: ProfileService;
  workspaces: WorkspaceService;
  snapshots: SnapshotService;
  /** Editing rows and tables: refuses everything unless started with `--enable-writes`. */
  writes: WriteService;
  /** Running one read-only statement the person typed (the SQL view). */
  sql: SqlService;
  savedQueries: SavedQueryService;
  /** Claude reading a database through MCP: what is shared, and the tools (decision 169). */
  mcp: McpService;
}

const CONTEXT_KEY = Symbol.for("datacanvas.server-context");
type WithContext = { [CONTEXT_KEY]?: ServerContext };

function createServerContext(): ServerContext {
  const adapters = new AdapterRegistry<ProviderConfigs>();
  adapters.register("postgresql", createPostgresAdapter);

  const registry = new ConnectionRegistry();
  registry.startIdleSweeper();

  // Files live in the user's data folder (see storage/data-dir.ts); nothing is created until the first save.
  const dataDir = resolveDataDir();
  const profileStorage = new ProfileStorage(dataDir);
  const workspaceStorage = new WorkspaceStorage(dataDir);
  const profiles = new ProfileService({ profiles: profileStorage, workspaces: workspaceStorage });

  const connections = new ConnectionService({ adapters, connections: registry, profiles });
  const sql = new SqlService({ connections: registry });

  return {
    connections,
    snapshots: new SnapshotService({ snapshots: new SnapshotStorage(dataDir), connections }),
    profiles,
    workspaces: new WorkspaceService({ workspaces: workspaceStorage, profiles: profileStorage }),
    // The flag is read once, at start-up, from what the CLI set; nothing in the API can change it.
    writes: new WriteService({
      connections: registry,
      writesEnabled: readSecurityConfig().writesEnabled,
    }),
    sql,
    savedQueries: new SavedQueryService(registry, profiles, dataDir),
    mcp: new McpService({
      connections: registry,
      sql,
      rows: connections,
      version: process.env.DATACANVAS_VERSION,
    }),
  };
}

export function getServerContext(): ServerContext {
  const holder = globalThis as WithContext;
  const held = holder[CONTEXT_KEY] as Partial<ServerContext> | undefined;
  // In development a hot reload can leave a context made by older code, without
  // the write service or the SQL service. Replace it (closing its connections) instead of serving
  // routes that cannot work; in production this never happens.
  if (held && (!held.writes || !held.sql || !held.savedQueries || !held.mcp)) {
    void held.connections?.dispose().catch(() => {});
    holder[CONTEXT_KEY] = undefined;
  }
  holder[CONTEXT_KEY] ??= createServerContext();
  return holder[CONTEXT_KEY];
}

/**
 * Close all database connections if a context exists. Never creates one (a
 * shutdown must not start new work). Safe to call more than once.
 */
export async function disposeServerContext(): Promise<void> {
  const context = (globalThis as WithContext)[CONTEXT_KEY];
  if (context) await context.connections.dispose();
}

/** For tests only: replace the shared context (pass undefined to reset). */
export function setServerContextForTests(context: ServerContext | undefined): void {
  (globalThis as WithContext)[CONTEXT_KEY] = context;
}
