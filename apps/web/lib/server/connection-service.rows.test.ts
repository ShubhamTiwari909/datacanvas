/**
 * Viewing table data on a connection: the `dataAccess` setting (off by default,
 * remembered with a saved connection), and the one place rows are read, which
 * refuses before it touches the database.
 */
import { describe, expect, it, vi } from "vitest";
import { encodeRowsCursor } from "@datacanvas/database-core";
import { postgresConnectionInputSchema, type ParsedRowsRequest } from "@datacanvas/shared-types";
import { createTestContext, fieldsInput } from "./test-support";

const input = (overrides: Record<string, unknown> = {}) =>
  postgresConnectionInputSchema.parse(fieldsInput(overrides));

const request = (overrides: Partial<ParsedRowsRequest> = {}): ParsedRowsRequest => ({
  schema: "public",
  table: "users",
  pageSize: 50,
  cursor: null,
  revealColumns: [],
  ...overrides,
});

describe("dataAccess of a connection", () => {
  it("is off unless asked for", async () => {
    const { connections } = createTestContext();
    expect((await connections.createConnection(input())).dataAccess).toBe(false);
  });

  it("can be switched on when connecting", async () => {
    const { connections } = createTestContext();
    expect((await connections.createConnection(input({ dataAccess: true }))).dataAccess).toBe(true);
  });

  it("can be switched on and off later, and the summary follows", async () => {
    const { connections } = createTestContext();
    const { id } = await connections.createConnection(input());

    expect((await connections.setDataAccess(id, true)).dataAccess).toBe(true);
    expect(connections.listConnections()[0]!.dataAccess).toBe(true);
    expect((await connections.setDataAccess(id, false)).dataAccess).toBe(false);
    expect(connections.listConnections()[0]!.dataAccess).toBe(false);
  });

  it("rejects an unknown connection", async () => {
    const { connections } = createTestContext();
    await expect(connections.setDataAccess("missing", true)).rejects.toMatchObject({
      code: "connection_not_found",
    });
  });

  it("never carries the password", async () => {
    const { connections } = createTestContext();
    const summary = await connections.createConnection(input({ dataAccess: true }));
    expect(JSON.stringify(summary)).not.toContain("s3cret-pw");
  });

  describe("with a saved connection", () => {
    it("is saved with the connection when remembered", async () => {
      const { connections, profiles } = createTestContext();
      await connections.createConnection(input({ remember: true, dataAccess: true }));
      expect((await profiles.list())[0]).toMatchObject({ dataAccess: true });
    });

    it("is off in a saved connection unless it was on", async () => {
      const { connections, profiles } = createTestContext();
      await connections.createConnection(input({ remember: true }));
      expect((await profiles.list())[0]).toMatchObject({ dataAccess: false });
    });

    it("changing it later is remembered, and comes back when the connection is reopened", async () => {
      const { connections, profiles } = createTestContext();
      const first = await connections.createConnection(input({ remember: true }));
      await connections.setDataAccess(first.id, true);
      expect((await profiles.list())[0]!.dataAccess).toBe(true);

      await connections.deleteConnection(first.id);
      const profile = (await profiles.list())[0]!;
      const reopened = await connections.createConnection(input({ profileId: profile.id }));
      expect(reopened.dataAccess).toBe(true); // brought back from the saved connection
    });

    it("reopening with an explicit choice uses it and remembers it", async () => {
      const { connections, profiles } = createTestContext();
      const first = await connections.createConnection(input({ remember: true, dataAccess: true }));
      await connections.deleteConnection(first.id);
      const profile = (await profiles.list())[0]!;

      const off = await connections.createConnection(
        input({ profileId: profile.id, dataAccess: false }),
      );
      expect(off.dataAccess).toBe(false);
      expect((await profiles.get(profile.id)).dataAccess).toBe(false);
    });

    it("remembering a database that is already saved keeps the choice just made", async () => {
      const { connections, profiles } = createTestContext();
      await connections.createConnection(input({ remember: true }));
      await connections.createConnection(input({ remember: true, dataAccess: true }));
      expect(await profiles.list()).toHaveLength(1);
      expect((await profiles.list())[0]!.dataAccess).toBe(true);
    });

    it("saving a live connection later saves its current setting", async () => {
      const { connections, profiles } = createTestContext();
      const { id } = await connections.createConnection(input({ dataAccess: true }));
      await connections.saveConnection(id);
      expect((await profiles.list())[0]!.dataAccess).toBe(true);
    });

    it("a connection that was not saved writes nothing to disk when the setting changes", async () => {
      const { connections, profiles } = createTestContext();
      const { id } = await connections.createConnection(input());
      await connections.setDataAccess(id, true);
      expect(await profiles.list()).toEqual([]);
    });
  });
});

describe("ConnectionService.getRows", () => {
  it("refuses when data access is off, before the database is touched", async () => {
    const { connections, createdAdapters } = createTestContext();
    const { id } = await connections.createConnection(input());
    const spy = vi.spyOn(createdAdapters[0]!, "getRows");

    await expect(connections.getRows(id, request())).rejects.toMatchObject({
      name: "ServiceError",
      code: "data_access_disabled",
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it("gives the refusal even for a table that does not exist (it must not reveal anything)", async () => {
    const { connections } = createTestContext();
    const { id } = await connections.createConnection(input());
    await expect(
      connections.getRows(id, request({ table: "no_such_table" })),
    ).rejects.toMatchObject({
      code: "data_access_disabled",
    });
  });

  it("answers an unknown connection with connection_not_found, not with the refusal", async () => {
    const { connections } = createTestContext();
    await expect(connections.getRows("missing", request())).rejects.toMatchObject({
      code: "connection_not_found",
    });
  });

  it("returns a page once data access is on, and refuses again once it is off", async () => {
    const { connections } = createTestContext();
    const { id } = await connections.createConnection(input({ dataAccess: true }));

    const page = await connections.getRows(id, request({ pageSize: 2 }));
    expect(page.rows.map((row) => row[0]!.value)).toEqual(["1", "2"]);
    expect(page.nextCursor).not.toBeNull();

    await connections.setDataAccess(id, false);
    await expect(connections.getRows(id, request())).rejects.toMatchObject({
      code: "data_access_disabled",
    });
  });

  it("continues from a cursor", async () => {
    const { connections } = createTestContext();
    const { id } = await connections.createConnection(input({ dataAccess: true }));
    const first = await connections.getRows(id, request({ pageSize: 2 }));
    const second = await connections.getRows(
      id,
      request({ pageSize: 2, cursor: first.nextCursor }),
    );
    expect(second.rows.map((row) => row[0]!.value)).toEqual(["3"]);
    expect(second.nextCursor).toBeNull();
  });

  it("passes the adapter's own errors through unchanged", async () => {
    const { connections } = createTestContext();
    const { id } = await connections.createConnection(input({ dataAccess: true }));
    await expect(
      connections.getRows(id, request({ table: "no_such_table" })),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      connections.getRows(id, request({ cursor: "not a cursor!" })),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(
      connections.getRows(id, request({ cursor: encodeRowsCursor({ kind: "offset", offset: 1 }) })),
    ).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("reads one page at a time per connection, and refuses when too many wait", async () => {
    const { connections, createdAdapters } = createTestContext();
    const { id } = await connections.createConnection(input({ dataAccess: true }));
    const adapter = createdAdapters[0]!;
    let running = 0;
    let peak = 0;
    const real = adapter.getRows.bind(adapter);
    vi.spyOn(adapter, "getRows").mockImplementation(async (table, options) => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running -= 1;
      return real(table, options);
    });

    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => connections.getRows(id, request())),
    );

    expect(peak).toBe(1);
    // One read runs and three wait; the rest are refused.
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(4);
    for (const failed of results.filter((r) => r.status === "rejected")) {
      expect((failed as PromiseRejectedResult).reason).toMatchObject({ code: "rows_busy" });
    }
  });

  it("is refused on a connection that was disconnected", async () => {
    const { connections } = createTestContext();
    const { id } = await connections.createConnection(input({ dataAccess: true }));
    await connections.deleteConnection(id);
    await expect(connections.getRows(id, request())).rejects.toMatchObject({
      code: "connection_not_found",
    });
  });
});
