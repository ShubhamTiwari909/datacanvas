/**
 * The SQL service: its checks and their order, one statement at a time per connection, a
 * refusal by the database as an answer, cancelling, and that neither the text nor a value is
 * ever logged.
 */
import {
  DatabaseError,
  SqlStatementError,
  type SqlRunRequest as AdapterRequest,
  type SqlRunResult,
} from "@datacanvas/database-core";
import { MockDatabaseAdapter } from "@datacanvas/database-core/testing";
import type { ConnectionSummary } from "@datacanvas/shared-types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectionRegistry } from "./connection-registry";
import { SQL_MESSAGES, SqlService } from "./sql-service";

const details: Omit<ConnectionSummary, "id"> = {
  provider: "postgresql",
  name: "Shop",
  host: "localhost",
  port: 5432,
  database: "shop",
  username: "alice",
  sslMode: "disable",
  hasPassword: true,
  dataAccess: true,
  profileId: null,
};
const SECRET = "zz-distinctive-sql-9f3a";
const request = (text: string, over: Partial<{ maxRows: number; timeoutMs: number }> = {}) => ({
  text,
  maxRows: 1000,
  timeoutMs: 30_000,
  ...over,
});
const answer = (value: string): SqlRunResult => ({
  columns: [{ name: "v", dataType: "text" }],
  rows: [[value]],
  truncated: false,
  command: "SELECT",
  cutCells: 0,
  elapsedMs: 1,
});

let logged: unknown[][];
beforeEach(() => {
  logged = [];
  for (const method of ["error", "warn", "log", "info", "debug"] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => void logged.push(args));
  }
});
afterEach(() => vi.restoreAllMocks());

async function setup(summary: Partial<Omit<ConnectionSummary, "id">> = {}) {
  const registry = new ConnectionRegistry();
  const adapter = new MockDatabaseAdapter();
  await adapter.connect();
  const service = new SqlService({ connections: registry });
  const { id } = registry.add({ ...details, ...summary }, adapter);
  return { registry, service, adapter, id };
}

describe("SqlService", () => {
  it("runs a statement and returns its result", async () => {
    const { service, adapter, id } = await setup();
    const seen: AdapterRequest[] = [];
    adapter.sqlHandler = async (r) => {
      seen.push(r);
      return answer("one");
    };
    const outcome = await service.run(id, request("SELECT 'one'"));
    expect(outcome).toEqual({ result: answer("one") });
    expect(seen[0]).toMatchObject({ text: "SELECT 'one'", maxRows: 1000, timeoutMs: 30_000 });
  });

  it("checks the connection, then viewing table data", async () => {
    const { service, id } = await setup({ dataAccess: false });
    await expect(service.run("missing", request("SELECT 1"))).rejects.toMatchObject({
      code: "connection_not_found",
    });
    await expect(service.run(id, request("SELECT 1"))).rejects.toMatchObject({
      code: "data_access_disabled",
      message: SQL_MESSAGES.dataAccessOff,
    });
  });

  it("answers a statement that may not be run without asking the database", async () => {
    const { service, adapter, id } = await setup();
    const handler = vi.fn(async () => answer("x"));
    adapter.sqlHandler = handler;
    for (const text of ["DROP TABLE t", "COPY (SELECT 1) TO PROGRAM 'id'", "DO $$ BEGIN END $$"]) {
      const outcome = await service.run(id, request(text));
      expect(outcome).toMatchObject({ failure: { code: "not_allowed", position: null } });
    }
    expect(handler).not.toHaveBeenCalled();
  });

  it("returns the database's refusal as an answer, with its code and position", async () => {
    const { service, adapter, id } = await setup();
    adapter.sqlHandler = async () => {
      throw new SqlStatementError("42P01", 'relation "nope" does not exist', 15);
    };
    expect(await service.run(id, request("SELECT * FROM nope"))).toEqual({
      failure: { code: "42P01", message: 'relation "nope" does not exist', position: 15 },
    });
  });

  it("throws what is about the connection, not the statement", async () => {
    const { service, adapter, id } = await setup();
    adapter.sqlHandler = async () => {
      throw new DatabaseError("unreachable");
    };
    await expect(service.run(id, request("SELECT 1"))).rejects.toMatchObject({
      code: "unreachable",
    });
  });

  it("runs one statement at a time per connection, and frees the connection afterwards", async () => {
    const { service, adapter, id, registry } = await setup();
    const other = registry.add({ ...details, name: "Other" }, new MockDatabaseAdapter()).id;
    let release: () => void = () => {};
    adapter.sqlHandler = () =>
      new Promise<SqlRunResult>((resolve) => {
        release = () => resolve(answer("late"));
      });
    const first = service.run(id, request("SELECT 1"));
    await Promise.resolve();
    await expect(service.run(id, request("SELECT 2"))).rejects.toMatchObject({ code: "sql_busy" });
    // Another connection is not held up.
    await (
      registry as unknown as { get: (i: string) => { adapter: MockDatabaseAdapter } | undefined }
    )
      .get?.(other)
      ?.adapter.connect();
    release();
    expect(await first).toEqual({ result: answer("late") });
    adapter.sqlHandler = async () => answer("again");
    expect(await service.run(id, request("SELECT 3"))).toEqual({ result: answer("again") });
  });

  it("frees the connection after a failure too", async () => {
    const { service, adapter, id } = await setup();
    adapter.sqlHandler = async () => {
      throw new SqlStatementError("22012", "division by zero");
    };
    await service.run(id, request("SELECT 1/0"));
    adapter.sqlHandler = async () => answer("fine");
    expect(await service.run(id, request("SELECT 1"))).toEqual({ result: answer("fine") });
  });

  it("cancels the statement when the client goes away", async () => {
    const { service, adapter, id } = await setup();
    let signal: AbortSignal | undefined;
    adapter.sqlHandler = (r) =>
      new Promise<SqlRunResult>((_, reject) => {
        signal = r.signal as AbortSignal;
        r.signal?.addEventListener("abort", () =>
          reject(new SqlStatementError("cancelled", "The query was cancelled.")),
        );
      });
    const client = new AbortController();
    const running = service.run(id, request("SELECT pg_sleep(30)"), client.signal);
    await Promise.resolve();
    client.abort();
    expect(await running).toMatchObject({ failure: { code: "cancelled" } });
    expect(signal?.aborted).toBe(true);
  });

  it("cancels what is running when the connection is closed", async () => {
    const { service, adapter, id, registry } = await setup();
    adapter.sqlHandler = (r) =>
      new Promise<SqlRunResult>((_, reject) => {
        r.signal?.addEventListener("abort", () =>
          reject(new SqlStatementError("cancelled", "The query was cancelled.")),
        );
      });
    const running = service.run(id, request("SELECT pg_sleep(30)"));
    await Promise.resolve();
    await registry.remove(id);
    expect(await running).toMatchObject({ failure: { code: "cancelled" } });
  });

  it("clamps the limits and never logs the text or a value", async () => {
    const { service, adapter, id } = await setup();
    const seen: AdapterRequest[] = [];
    adapter.sqlHandler = async (r) => {
      seen.push(r);
      return answer(SECRET);
    };
    await service.run(
      id,
      request(`SELECT '${SECRET}'`, { maxRows: 999_999, timeoutMs: 99_999_999 }),
    );
    expect(seen[0]?.maxRows).toBe(10_000);
    expect(seen[0]?.timeoutMs).toBe(300_000);
    adapter.sqlHandler = async () => {
      throw new Error(`boom ${SECRET}`);
    };
    await service.run(id, request(`SELECT '${SECRET}'`)).catch(() => {});
    expect(JSON.stringify(logged)).not.toContain(SECRET);
  });
});
