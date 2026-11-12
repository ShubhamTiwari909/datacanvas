/**
 * Turn DataCanvas connection details into `pg` driver settings.
 */
import type { PostgresSslMode, ResolvedPostgresConnection } from "@datacanvas/shared-types";
import type { PoolConfig } from "pg";

/** Tunable limits. Every one exists to bound how long or how much we ask of someone else's database. */
export interface PostgresAdapterOptions {
  /** Give up connecting after this long. Default 10 s. */
  connectTimeoutMs?: number;
  /** Cancel any single catalog query that runs longer than this. Default 15 s. */
  statementTimeoutMs?: number;
  /** Maximum simultaneous connections in the pool. Default 3 (we only run small, short queries). */
  maxConnections?: number;
}

export const DEFAULT_ADAPTER_OPTIONS = {
  connectTimeoutMs: 10_000,
  statementTimeoutMs: 15_000,
  maxConnections: 3,
} as const;

/** Resolved (defaults applied) options. */
export type ResolvedAdapterOptions = { [K in keyof PostgresAdapterOptions]-?: number };

export function resolveAdapterOptions(
  options: PostgresAdapterOptions = {},
): ResolvedAdapterOptions {
  return {
    connectTimeoutMs: options.connectTimeoutMs ?? DEFAULT_ADAPTER_OPTIONS.connectTimeoutMs,
    statementTimeoutMs: options.statementTimeoutMs ?? DEFAULT_ADAPTER_OPTIONS.statementTimeoutMs,
    maxConnections: options.maxConnections ?? DEFAULT_ADAPTER_OPTIONS.maxConnections,
  };
}

/**
 * Map our SSL mode to the driver's `ssl` option.
 *
 *   disable      -> false (plain TCP, no encryption)
 *   require      -> TLS on, certificate NOT checked (stops eavesdropping, not impersonation)
 *   verify-full  -> TLS on, certificate chain AND host name checked (Node's TLS does
 *                   the host-name check when rejectUnauthorized is true)
 */
export function sslModeToPgSsl(mode: PostgresSslMode): false | { rejectUnauthorized: boolean } {
  switch (mode) {
    case "disable":
      return false;
    case "require":
      return { rejectUnauthorized: false };
    case "verify-full":
      return { rejectUnauthorized: true };
  }
}

/**
 * Build the driver configuration. Two details are deliberate:
 *
 *  - We pass individual fields, never a connection string, so no URL (which
 *    would contain the password) is ever assembled, logged or parsed again.
 *  - `ssl` is always set explicitly. If it were left undefined the driver
 *    would read the PGSSLMODE environment variable of whoever runs DataCanvas
 *    and silently change our security setting.
 */
export function buildPoolConfig(
  connection: ResolvedPostgresConnection,
  options: ResolvedAdapterOptions,
): PoolConfig {
  return {
    host: connection.host,
    port: connection.port,
    database: connection.database,
    user: connection.username,
    password: connection.password,
    ssl: sslModeToPgSsl(connection.sslMode),
    application_name: "datacanvas", // shows up in pg_stat_activity so DBAs can recognise us
    connectionTimeoutMillis: options.connectTimeoutMs,
    max: options.maxConnections,
    idleTimeoutMillis: 30_000, // close idle connections instead of holding them open
  };
}
