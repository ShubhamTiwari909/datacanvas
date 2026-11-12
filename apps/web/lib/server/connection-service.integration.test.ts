/**
 * The ConnectionService with the REAL PostgreSQL adapter, against a real
 * PostgreSQL. Skipped unless DATACANVAS_TEST_PG_URL is set (see CONTRIBUTING.md).
 * Proves that the pieces fit: registry + service + adapter + catalog queries.
 */
import { AdapterRegistry } from "@datacanvas/database-core";
import { createPostgresAdapter } from "@datacanvas/postgres-adapter";
import {
  createTestDatabase,
  testDatabaseUrl,
  type TestDatabase,
} from "@datacanvas/postgres-adapter/testing";
import { postgresConnectionInputSchema } from "@datacanvas/shared-types";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConnectionRegistry } from "./connection-registry";
import { ConnectionService, type ProviderConfigs } from "./connection-service";

describe.skipIf(!testDatabaseUrl())("ConnectionService with real PostgreSQL", () => {
  let db: TestDatabase;
  let registry: ConnectionRegistry;
  let service: ConnectionService;

  const input = (overrides: Record<string, unknown> = {}) =>
    postgresConnectionInputSchema.parse({
      mode: "fields",
      name: "Integration",
      host: db.connection.host,
      port: db.connection.port,
      database: db.connection.database,
      username: db.connection.username,
      password: db.connection.password,
      ...overrides,
    });

  beforeAll(async () => {
    db = await createTestDatabase();
    const adapters = new AdapterRegistry<ProviderConfigs>();
    adapters.register("postgresql", createPostgresAdapter);
    registry = new ConnectionRegistry({ idleTimeoutMs: 1 });
    service = new ConnectionService({ adapters, connections: registry });
  });

  afterAll(async () => {
    await registry.dispose();
    await db.dispose();
  });

  it("connects, explores and disconnects", async () => {
    const summary = await service.createConnection(input());
    expect(summary).toMatchObject({
      host: db.connection.host,
      database: db.dbName,
      hasPassword: true,
    });
    expect(JSON.stringify(summary)).not.toContain(db.connection.password);

    const schemas = (await service.getSchemas(summary.id)).map((s) => s.name);
    expect(schemas).toEqual(["analytics", "public"]);

    const tables = (await service.getTables(summary.id, "public")).map((t) => t.name);
    expect(tables).toEqual(expect.arrayContaining(["users", "orders", "order_items", "products"]));

    const details = await service.getTableDetails(summary.id, "public", "order_items");
    expect(details.columns.map((c) => c.name)).toEqual([
      "id",
      "order_id",
      "product_id",
      "quantity",
    ]);
    expect(details.constraints.map((c) => c.kind)).toContain("check");

    const relationships = await service.getRelationships(summary.id);
    expect(relationships.map((r) => r.name)).toContain("orders_user_id_fkey");

    await service.deleteConnection(summary.id);
    await expect(service.getSchemas(summary.id)).rejects.toMatchObject({
      code: "connection_not_found",
    });
  });

  it("reconnects transparently after the idle sweeper closed the pool", async () => {
    const { id } = await service.createConnection(input());
    await service.getSchemas(id);

    await new Promise((resolve) => setTimeout(resolve, 5)); // idleTimeoutMs is 1
    expect(await registry.closeIdle()).toBe(1);

    await expect(service.getSchemas(id)).resolves.toHaveLength(2);
    await service.deleteConnection(id);
  });

  it("reports a wrong password as authentication_failed and stores nothing", async () => {
    const before = service.listConnections().length;
    await expect(
      service.createConnection(input({ password: "definitely-wrong" })),
    ).rejects.toMatchObject({
      code: "authentication_failed",
    });
    expect(service.listConnections()).toHaveLength(before);
  });

  it("tests a connection without saving it", async () => {
    const before = service.listConnections().length;
    await expect(service.testConnection(input())).resolves.toBeUndefined();
    expect(service.listConnections()).toHaveLength(before);
  });
});
