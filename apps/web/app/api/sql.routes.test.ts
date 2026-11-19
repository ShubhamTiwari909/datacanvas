/**
 * Route tests for the SQL view (1.6.0, decision 141): the strict body, the viewing switch, a
 * statement that may not be run, the database's refusal as an answer, one at a time, cancelling
 * with the request, and that neither the text nor a value ends up in a log.
 */
import { SqlStatementError, type SqlRunResult } from "@datacanvas/database-core";
import type { MockDatabaseAdapter } from "@datacanvas/database-core/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setServerContextForTests } from "@/lib/server/context";
import { createTestContext, fieldsInput, type TestContext } from "@/lib/server/test-support";
import { PUT as setDataAccess } from "./connections/[id]/data-access/route";
import { POST as run } from "./connections/[id]/run/route";
import { POST as createConnection } from "./connections/route";

const BASE = "http://127.0.0.1:4747/api";
const params = <T extends Record<string, string>>(value: T) => ({ params: Promise.resolve(value) });
const SECRET = "zz-distinctive-sql-text-5c1e";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
async function call(response: Promise<Response> | Response) {
  const r = await response;
  const text = await r.text();
  let body: Json;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = text;
  }
  return { status: r.status, body, text, headers: r.headers };
}
const json = (url: string, method: string, body: unknown, init: RequestInit = {}): Request =>
  new Request(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    ...init,
  });

let context: TestContext;
let logged: unknown[][];
beforeEach(() => {
  context = createTestContext();
  setServerContextForTests(context);
  logged = [];
  for (const method of ["error", "warn", "log", "info", "debug"] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => void logged.push(args));
  }
});
afterEach(() => {
  setServerContextForTests(undefined);
  vi.restoreAllMocks();
});

async function connect(extra: Record<string, unknown> = {}): Promise<string> {
  const { body } = await call(
    createConnection(json(`${BASE}/connections`, "POST", fieldsInput(extra))),
  );
  return body.connection.id;
}
const adapterOf = (): MockDatabaseAdapter => context.createdAdapters.at(-1)!;
const sql = (id: string, body: unknown, init: RequestInit = {}) =>
  call(run(json(`${BASE}/connections/${id}/run`, "POST", body, init), params({ id })));
const answer = (value: string): SqlRunResult => ({
  columns: [{ name: "v", dataType: "text" }],
  rows: [[value]],
  truncated: false,
  command: "SELECT",
  cutCells: 0,
  elapsedMs: 3,
});

describe("POST /connections/:id/run", () => {
  it("runs a statement and answers the result, never cached", async () => {
    const id = await connect({ dataAccess: true });
    adapterOf().sqlHandler = async () => answer("one");
    const result = await sql(id, { text: "SELECT 'one'" });
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ result: answer("one") });
    expect(result.headers.get("cache-control")).toBe("no-store");
  });

  it("applies the defaults for the two limits", async () => {
    const id = await connect({ dataAccess: true });
    const seen: unknown[] = [];
    adapterOf().sqlHandler = async (r) => {
      seen.push([r.maxRows, r.timeoutMs]);
      return answer("x");
    };
    await sql(id, { text: "SELECT 1" });
    expect(seen).toEqual([[1000, 30_000]]);
  });

  it("is refused while viewing table data is off, and allowed again when it is on", async () => {
    const id = await connect({ dataAccess: false });
    const refused = await sql(id, { text: "SELECT 1" });
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe("data_access_disabled");
    await call(
      setDataAccess(
        json(`${BASE}/connections/${id}/data-access`, "PUT", { enabled: true }),
        params({ id }),
      ),
    );
    adapterOf().sqlHandler = async () => answer("now");
    expect((await sql(id, { text: "SELECT 1" })).status).toBe(200);
  });

  it("answers a statement that is not allowed as a failure, without asking the database", async () => {
    const id = await connect({ dataAccess: true });
    const handler = vi.fn(async () => answer("x"));
    adapterOf().sqlHandler = handler;
    const result = await sql(id, { text: "DROP TABLE users" });
    expect(result.status).toBe(200);
    expect(result.body.failure).toMatchObject({ code: "not_allowed", position: null });
    expect(handler).not.toHaveBeenCalled();
  });

  it("answers the database's refusal with its code and position", async () => {
    const id = await connect({ dataAccess: true });
    adapterOf().sqlHandler = async () => {
      throw new SqlStatementError("42P01", 'relation "nope" does not exist', 15);
    };
    const result = await sql(id, { text: "SELECT * FROM nope" });
    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      failure: { code: "42P01", message: 'relation "nope" does not exist', position: 15 },
    });
  });

  it("refuses a second statement while one runs: 429 sql_busy", async () => {
    const id = await connect({ dataAccess: true });
    let release: () => void = () => {};
    let started: () => void = () => {};
    const running = new Promise<void>((resolve) => (started = resolve));
    adapterOf().sqlHandler = () =>
      new Promise<SqlRunResult>((resolve) => {
        release = () => resolve(answer("late"));
        started();
      });
    const first = sql(id, { text: "SELECT 1" });
    await running; // the first statement is with the adapter: the connection is busy
    const second = await sql(id, { text: "SELECT 2" });
    expect(second.status).toBe(429);
    expect(second.body.error.code).toBe("sql_busy");
    release();
    expect((await first).status).toBe(200);
  });

  it("cancels the statement when the request is aborted", async () => {
    const id = await connect({ dataAccess: true });
    let listening: () => void = () => {};
    const ready = new Promise<void>((resolve) => (listening = resolve));
    adapterOf().sqlHandler = (r) =>
      new Promise<SqlRunResult>((_, reject) => {
        r.signal?.addEventListener("abort", () =>
          reject(new SqlStatementError("cancelled", "The query was cancelled.")),
        );
        listening();
      });
    const controller = new AbortController();
    const running = sql(id, { text: "SELECT pg_sleep(30)" }, { signal: controller.signal });
    await ready; // the adapter is listening for the abort
    controller.abort();
    expect((await running).body.failure.code).toBe("cancelled");
  });

  it("refuses an unknown connection", async () => {
    const result = await sql("missing", { text: "SELECT 1" });
    expect(result.status).toBe(404);
    expect(result.body.error.code).toBe("connection_not_found");
  });
});

describe("the body", () => {
  it.each([
    [{}, "no text"],
    [{ text: "" }, "empty text"],
    [{ text: "SELECT 1", sql: "SELECT 2" }, "an extra key"],
    [{ text: "SELECT 1", params: [1] }, "parameters"],
    [{ text: "SELECT 1", maxRows: 0 }, "maxRows 0"],
    [{ text: "SELECT 1", maxRows: 10_001 }, "maxRows too big"],
    [{ text: "SELECT 1", maxRows: 1.5 }, "a fractional maxRows"],
    [{ text: "SELECT 1", timeoutMs: 10 }, "a timeout that is too short"],
    [{ text: "SELECT 1", timeoutMs: 300_001 }, "a timeout that is too long"],
    [{ text: 5 }, "text that is not text"],
    [{ text: "x".repeat(200_001) }, "text that is too long"],
  ])("refuses %j (%s) as a validation error", async (body: unknown, description: string) => {
    expect(description).toBeTruthy();
    const id = await connect({ dataAccess: true });
    const result = await sql(id, body);
    expect(result.status).toBe(400);
    expect(result.body.error.code).toBe("validation_error");
  });

  it("needs JSON, and refuses a body above the limit", async () => {
    const id = await connect({ dataAccess: true });
    const plain = await call(
      run(
        new Request(`${BASE}/connections/${id}/run`, {
          method: "POST",
          headers: { "Content-Type": "text/plain" },
          body: "SELECT 1",
        }),
        params({ id }),
      ),
    );
    expect(plain.status).toBe(415);
    const huge = await call(
      run(
        new Request(`${BASE}/connections/${id}/run`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          // More than the longest statement could ever take, in any encoding.
          body: JSON.stringify({ text: `SELECT '${"x".repeat(1_300_000)}'` }),
        }),
        params({ id }),
      ),
    );
    expect(huge.status).toBe(413);
  });

  it("is limited by the statement's length, not by the size of its body: a long statement in a wide script passes", async () => {
    const id = await connect({ dataAccess: true });
    adapterOf().sqlHandler = async () => answer("long");
    // 200,000 characters of three bytes each in UTF-8: 600 KB, more than the old body limit, and a legal statement.
    const text = `SELECT '${"名".repeat(199_000)}'`;
    const accepted = await sql(id, { text });
    expect(accepted.status).toBe(200);
    // One character over the limit is refused by the schema.
    const over = await sql(id, { text: `SELECT '${"名".repeat(200_001)}'` });
    expect(over.status).toBe(400);
    expect(over.body.error.code).toBe("validation_error");
  });
});

describe("privacy", () => {
  it("never logs the text or a value, whatever happens", async () => {
    const id = await connect({ dataAccess: true });
    adapterOf().sqlHandler = async () => answer(SECRET);
    await sql(id, { text: `SELECT '${SECRET}'` });
    adapterOf().sqlHandler = async () => {
      throw new Error(`driver said ${SECRET}`);
    };
    const failed = await sql(id, { text: `SELECT '${SECRET}'` });
    expect(failed.status).toBe(500);
    expect(failed.text).not.toContain(SECRET);
    await sql(id, { text: `DROP TABLE '${SECRET}'` });
    expect(JSON.stringify(logged)).not.toContain(SECRET);
  });
});
