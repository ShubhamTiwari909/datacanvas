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
import { ConnectionRegistry, type ConnectionRegistryOptions } from "./connection-registry";
import { ConnectionService, type ProviderConfigs } from "./connection-service";
import type { ServerContext } from "./context";

const FAILURES: Record<string, DatabaseErrorCode> = {
  "wrong-password": "authentication_failed",
  "no-such-host": "unreachable",
};

export interface TestContext extends ServerContext {
  registry: ConnectionRegistry;
  /** Every adapter the factory created, in order, so tests can inspect them. */
  createdAdapters: MockDatabaseAdapter[];
}

export function createTestContext(registryOptions: ConnectionRegistryOptions = {}): TestContext {
  const createdAdapters: MockDatabaseAdapter[] = [];
  const adapters = new AdapterRegistry<ProviderConfigs>();
  adapters.register("postgresql", (config) => {
    const failure = FAILURES[config.password];
    const adapter = new MockDatabaseAdapter(failure ? { failConnectWith: failure } : {});
    createdAdapters.push(adapter);
    return adapter;
  });
  const registry = new ConnectionRegistry(registryOptions);
  return {
    connections: new ConnectionService({ adapters, connections: registry }),
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
