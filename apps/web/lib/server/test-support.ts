/**
 * Helpers for tests of the server code: a ConnectionService backed by mock
 * adapters, so no database is needed.
 *
 * The mock reacts to the password so tests can trigger failures:
 *   "wrong-password"   -> authentication_failed
 *   "no-such-host"     -> unreachable
 * Anything else connects fine.
 */
import { AdapterRegistry, type DatabaseErrorCode } from "@datacanvas/database-core";
import { MockDatabaseAdapter } from "@datacanvas/database-core/testing";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach } from "vitest";
import { ConnectionRegistry, type ConnectionRegistryOptions } from "./connection-registry";
import { ConnectionService, type ProviderConfigs } from "./connection-service";
import type { ServerContext } from "./context";
import { ProfileService } from "./profile-service";
import { SnapshotService } from "./snapshot-service";
import { McpService } from "./mcp-service";
import { SqlService } from "./sql-service";
import { SnapshotStorage } from "./storage/snapshot-storage";
import { ProfileStorage } from "./storage/profile-storage";
import { WorkspaceStorage } from "./storage/workspace-storage";
import { WorkspaceService } from "./workspace-service";
import { WriteService } from "./write-service";

const FAILURES: Record<string, DatabaseErrorCode> = {
  "wrong-password": "authentication_failed",
  "no-such-host": "unreachable",
};

/** Temporary data folders created by tests; removed after each test. */
const temporaryDirectories: string[] = [];

/** Make a fresh, empty data folder under the system temp directory (never the user's real one). */
export function createTestDataDir(): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), "datacanvas-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

export function removeTestDataDirs(): void {
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { recursive: true, force: true });
}

// Registered when a test file imports this module, so every test cleans up after itself.
afterEach(removeTestDataDirs);

export interface TestContext extends ServerContext {
  /** The temporary data folder this context stores its files in. */
  dataDir: string;
  registry: ConnectionRegistry;
  /** Every adapter the factory created, in order, so tests can inspect them. */
  createdAdapters: MockDatabaseAdapter[];
}

export function createTestContext(
  registryOptions: ConnectionRegistryOptions = {},
  options: {
    dataDir?: string;
    now?: () => Date;
    writesEnabled?: boolean;
    exportStallMs?: number;
  } = {},
): TestContext {
  const dataDir = options.dataDir ?? createTestDataDir();
  const createdAdapters: MockDatabaseAdapter[] = [];
  const adapters = new AdapterRegistry<ProviderConfigs>();
  adapters.register("postgresql", (config) => {
    const failure = FAILURES[config.password];
    const adapter = new MockDatabaseAdapter(failure ? { failConnectWith: failure } : {});
    createdAdapters.push(adapter);
    return adapter;
  });
  const registry = new ConnectionRegistry(registryOptions);
  const profileStorage = new ProfileStorage(dataDir);
  const workspaceStorage = new WorkspaceStorage(dataDir);
  const profiles = new ProfileService({
    profiles: profileStorage,
    workspaces: workspaceStorage,
    now: options.now,
  });
  const connections = new ConnectionService({
    adapters,
    connections: registry,
    profiles,
    ...(options.exportStallMs === undefined ? {} : { exportStallMs: options.exportStallMs }),
  });
  return {
    connections,
    snapshots: new SnapshotService({
      snapshots: new SnapshotStorage(dataDir),
      connections,
      now: options.now,
    }),
    profiles,
    workspaces: new WorkspaceService({
      workspaces: workspaceStorage,
      profiles: profileStorage,
      now: options.now,
    }),
    // Off unless a test asks for it, as in production without `--enable-writes`.
    writes: new WriteService({
      connections: registry,
      writesEnabled: options.writesEnabled ?? false,
      now: options.now ? () => options.now!().getTime() : undefined,
    }),
    sql: new SqlService({ connections: registry }),
    mcp: new McpService({ connections: registry }),
    dataDir,
    registry,
    createdAdapters,
  };
}

/** A valid "fields" request body. */
export function fieldsInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    mode: "fields",
    name: "Shop",
    host: "localhost",
    database: "shop",
    username: "alice",
    password: "s3cret-pw",
    ...overrides,
  };
}
