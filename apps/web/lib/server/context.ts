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
import { WorkspaceService } from "./workspace-service";

export interface ServerContext {
  connections: ConnectionService;
  profiles: ProfileService;
  workspaces: WorkspaceService;
  snapshots: SnapshotService;
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

  return {
    connections,
    snapshots: new SnapshotService({ snapshots: new SnapshotStorage(dataDir), connections }),
    profiles,
    workspaces: new WorkspaceService({ workspaces: workspaceStorage, profiles: profileStorage }),
  };
}

export function getServerContext(): ServerContext {
  const holder = globalThis as WithContext;
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
