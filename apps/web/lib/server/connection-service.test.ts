import { describe, expect, it } from "vitest";
import { postgresConnectionInputSchema } from "@datacanvas/shared-types";
import { createTestContext, fieldsInput } from "./test-support";

const input = (overrides: Record<string, unknown> = {}) =>
  postgresConnectionInputSchema.parse(fieldsInput(overrides));

describe("ConnectionService", () => {
  it("creates a connection, returning a summary without the password", async () => {
    const { connections } = createTestContext();
    const summary = await connections.createConnection(input({ port: 6543, sslMode: "require" }));

    expect(summary).toMatchObject({
      provider: "postgresql",
      name: "Shop",
      host: "localhost",
      port: 6543,
      database: "shop",
      username: "alice",
      sslMode: "require",
      hasPassword: true,
    });
    expect(summary.id).toBeTruthy();
    expect(JSON.stringify(summary)).not.toContain("s3cret-pw");
    expect(connections.listConnections()).toEqual([summary]);
  });

  it("resolves the SSL mode from the host when none is given", async () => {
    const { connections } = createTestContext();
    expect((await connections.createConnection(input({ host: "localhost" }))).sslMode).toBe(
      "disable",
    );
    expect((await connections.createConnection(input({ host: "db.example.com" }))).sslMode).toBe(
      "verify-full",
    );
  });

  it("stores nothing when connecting fails", async () => {
    const { connections } = createTestContext();
    await expect(
      connections.createConnection(input({ password: "wrong-password" })),
    ).rejects.toMatchObject({
      code: "authentication_failed",
    });
    expect(connections.listConnections()).toEqual([]);
  });

  it("disconnects the new adapter if the registry turns out to be full", async () => {
    const { connections, createdAdapters } = createTestContext({ maxConnections: 1 });
    await connections.createConnection(input());
    await expect(connections.createConnection(input())).rejects.toMatchObject({
      code: "connection_limit_reached",
    });
    // The second adapter was connected and must have been closed again.
    await expect(createdAdapters[1]?.getSchemas()).rejects.toMatchObject({ code: "not_connected" });
  });

  it("tests a connection without remembering it", async () => {
    const { connections } = createTestContext();
    await expect(connections.testConnection(input())).resolves.toBeUndefined();
    expect(connections.listConnections()).toEqual([]);
    await expect(
      connections.testConnection(input({ password: "no-such-host" })),
    ).rejects.toMatchObject({
      code: "unreachable",
    });
  });

  it("explores a connection: schemas, tables, details, relationships", async () => {
    const { connections } = createTestContext();
    const { id } = await connections.createConnection(input());

    expect((await connections.getSchemas(id)).map((s) => s.name)).toEqual(["analytics", "public"]);
    expect((await connections.getTables(id, "public")).map((t) => t.name)).toContain("orders");

    const details = await connections.getTableDetails(id, "public", "orders");
    expect(details.columns.map((c) => c.name)).toEqual(["id", "user_id", "status", "placed_at"]);
    expect(details.constraints.map((c) => c.kind)).toContain("foreign_key");
    expect(details.indexes.map((i) => i.name)).toContain("orders_pkey");

    expect(await connections.getRelationships(id)).toHaveLength(3);
  });

  it("reports not_found for a missing table or schema", async () => {
    const { connections } = createTestContext();
    const { id } = await connections.createConnection(input());
    await expect(connections.getTableDetails(id, "public", "nope")).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(connections.getTables(id, "nope")).rejects.toMatchObject({ code: "not_found" });
  });

  it("rejects every operation on an unknown connection id", async () => {
    const { connections } = createTestContext();
    const unknown = { code: "connection_not_found" };
    await expect(connections.getSchemas("nope")).rejects.toMatchObject(unknown);
    await expect(connections.getTables("nope", "public")).rejects.toMatchObject(unknown);
    await expect(connections.getTableDetails("nope", "public", "users")).rejects.toMatchObject(
      unknown,
    );
    await expect(connections.getRelationships("nope")).rejects.toMatchObject(unknown);
    await expect(connections.deleteConnection("nope")).rejects.toMatchObject(unknown);
  });

  it("deleting a connection makes it unusable", async () => {
    const { connections } = createTestContext();
    const { id } = await connections.createConnection(input());
    await connections.deleteConnection(id);
    expect(connections.listConnections()).toEqual([]);
    await expect(connections.getSchemas(id)).rejects.toMatchObject({
      code: "connection_not_found",
    });
  });
});
