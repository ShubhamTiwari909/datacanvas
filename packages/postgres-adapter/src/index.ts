/**
 * @datacanvas/postgres-adapter
 *
 * PostgreSQL implementation of the DatabaseAdapter interface from
 * @datacanvas/database-core. Register it with the server's AdapterRegistry:
 *
 *   registry.register("postgresql", createPostgresAdapter);
 */
export { PostgresAdapter, createPostgresAdapter } from "./postgres.adapter.js";
export type { PostgresAdapterOptions } from "./connection/config.js";
export { mapPgError } from "./connection/errors.js";
