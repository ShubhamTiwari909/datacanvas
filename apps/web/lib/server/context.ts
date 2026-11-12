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

export interface ServerContext {
  connections: ConnectionService;
}

const CONTEXT_KEY = Symbol.for("datacanvas.server-context");
type WithContext = { [CONTEXT_KEY]?: ServerContext };

function createServerContext(): ServerContext {
  const adapters = new AdapterRegistry<ProviderConfigs>();
  adapters.register("postgresql", createPostgresAdapter);

  const registry = new ConnectionRegistry();
  registry.startIdleSweeper();

  return { connections: new ConnectionService({ adapters, connections: registry }) };
}

export function getServerContext(): ServerContext {
  const holder = globalThis as WithContext;
  holder[CONTEXT_KEY] ??= createServerContext();
  return holder[CONTEXT_KEY];
}

/** For tests only: replace the shared context (pass undefined to reset). */
export function setServerContextForTests(context: ServerContext | undefined): void {
  (globalThis as WithContext)[CONTEXT_KEY] = context;
}
