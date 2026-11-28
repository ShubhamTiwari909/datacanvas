/**
 * Route tests for the SQL view (1.6.0, decision 141): the strict body, the viewing switch, a
 * statement that may not be run, the database's refusal as an answer, one at a time, cancelling
 * with the request, and that neither the text nor a value ends up in a log.
 */
import { mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { SqlStatementError, type SqlRunResult } from "@datacanvas/database-core";
import type { MockDatabaseAdapter } from "@datacanvas/database-core/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setServerContextForTests } from "@/lib/server/context";
import { createTestContext, fieldsInput, type TestContext } from "@/lib/server/test-support";
import { PUT as setDataAccess } from "./connections/[id]/data-access/route";
import { DELETE as disconnect } from "./connections/[id]/route";
import { GET as listSaved, POST as saveQuery } from "./connections/[id]/saved-queries/route";
import {
  DELETE as removeSaved,
  GET as openSaved,
  PUT as renameSaved,
} from "./connections/[id]/saved-queries/[queryId]/route";
import { DELETE as forget } from "./profiles/[id]/route";
import { POST as saveConnection } from "./connections/[id]/save/route";
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

describe("the local saved-query library", () => {
  const queryPath = (id: string) => `${BASE}/connections/${id}/saved-queries`;
  const list = (id: string) => call(listSaved(new Request(queryPath(id)), params({ id })));
  const save = (id: string, body: unknown) =>
    call(saveQuery(json(queryPath(id), "POST", body), params({ id })));
  const input = {
    name: "Example query",
    text: `  SELECT '${SECRET}' AS value;
`,
  };

  it("persists explicit saves per profile, returns names alone in lists, and never runs the saved text", async () => {
    const id = await connect({ remember: true, dataAccess: true });
    const profileId = context.registry.getSummary(id)!.profileId!;
    const handler = vi.fn(async () => answer("not called"));
    adapterOf().sqlHandler = handler;

    const saved = await save(id, input);
    expect(saved.status).toBe(200);
    expect(saved.headers.get("cache-control")).toBe("no-store");
    const { id: queryId } = saved.body.queries[0];
    expect(saved.body).toEqual({ queries: [{ id: queryId, name: input.name }] });
    expect(saved.text).not.toContain(SECRET);
    expect(handler).not.toHaveBeenCalled();
    expect(logged.flat().join(" ")).not.toContain(SECRET);
    const file = path.join(context.dataDir, "saved-queries", `${profileId}.json`);
    expect(await readFile(file, "utf8")).toContain(SECRET);
    if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600);

    const another = await connect({ database: "another", remember: true, dataAccess: true });
    expect((await list(another)).body.queries).toEqual([]);
    expect(
      (await call(openSaved(new Request(queryPath(another)), params({ id: another, queryId }))))
        .status,
    ).toBe(404);
    const wrongTarget = await connect({ database: "wrong-target", profileId, dataAccess: true });
    expect((await list(wrongTarget)).status).toBe(404);
    expect((await save(id, { ...input, name: input.name.toUpperCase() })).status).toBe(409);

    await call(
      disconnect(new Request(`${BASE}/connections/${id}`, { method: "DELETE" }), params({ id })),
    );
    context = createTestContext({}, { dataDir: context.dataDir });
    setServerContextForTests(context);
    const reopened = await connect({ profileId, dataAccess: true });
    const current = params({ id: reopened, queryId });
    expect((await call(openSaved(new Request(queryPath(reopened)), current))).body).toEqual({
      id: queryId,
      ...input,
    });
    expect(
      (await call(renameSaved(json(queryPath(reopened), "PUT", { name: "Renamed" }), current))).body
        .queries[0].name,
    ).toBe("Renamed");
    expect(
      (await call(removeSaved(new Request(queryPath(reopened), { method: "DELETE" }), current)))
        .body.queries,
    ).toEqual([]);
    await save(reopened, input);
    expect(
      (
        await call(
          forget(
            new Request(`${BASE}/profiles/${profileId}`, { method: "DELETE" }),
            params({ id: profileId }),
          ),
        )
      ).status,
    ).toBe(200);
    await expect(stat(file)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await list(reopened)).body.queries).toEqual([]);
  });

  it("keeps session queries when a connection is saved, including a name already in the profile", async () => {
    const original = await connect({ remember: true, dataAccess: true });
    const existing = await save(original, input);
    const temporary = await connect({ dataAccess: true });
    const draft = { ...input, text: "SELECT 42" };
    const session = await save(temporary, draft);
    const queryId = session.body.queries[0].id;
    expect((await list(temporary)).body.queries).toEqual(session.body.queries);

    const response = await call(
      saveConnection(
        new Request(`${BASE}/connections/${temporary}/save`, { method: "POST" }),
        params({ id: temporary }),
      ),
    );
    expect(response.status).toBe(200);
    const profileId = response.body.connection.profileId;
    expect(profileId).toBe(context.registry.getSummary(original)!.profileId);
    const reopened = await connect({ profileId, dataAccess: true });
    expect((await list(reopened)).body.queries).toEqual([
      ...existing.body.queries,
      { id: queryId, name: "Example query (2)" },
    ]);
    const opened = await call(
      openSaved(new Request(queryPath(reopened)), params({ id: reopened, queryId })),
    );
    expect(opened.body).toEqual({ id: queryId, ...draft, name: "Example query (2)" });
  });

  it("keeps the profile available when forgetting its library fails", async () => {
    const id = await connect({ remember: true, dataAccess: true });
    const profileId = context.registry.getSummary(id)!.profileId!;
    // Stand in for a file the server cannot remove.
    await mkdir(path.join(context.dataDir, "saved-queries", `${profileId}.json`), {
      recursive: true,
    });
    const response = await call(
      forget(
        new Request(`${BASE}/profiles/${profileId}`, { method: "DELETE" }),
        params({ id: profileId }),
      ),
    );
    expect(response.status).toBe(500);
    expect(response.body.error.code).toBe("storage_error");
    expect((await context.profiles.get(profileId)).id).toBe(profileId);
  });

  it("isolates temporary connections and refuses persistence payloads besides a name and text", async () => {
    const accessOff = await connect();
    expect((await save(accessOff, input)).status).toBe(403);
    const id = await connect({ dataAccess: true });
    expect((await save(id, { ...input, results: [SECRET] })).status).toBe(400);
    expect((await save(id, { ...input, text: "    " })).status).toBe(400);
    const [one, two] = await Promise.all([
      save(id, input),
      save(id, { ...input, name: "Another query" }),
    ]);
    expect(one.status).toBe(200);
    expect(two.status).toBe(200);
    expect((await list(id)).body.queries).toHaveLength(2);
    const another = await connect({ dataAccess: true });
    expect((await list(another)).body.queries).toEqual([]);
    await expect(stat(path.join(context.dataDir, "saved-queries"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await call(
      disconnect(new Request(`${BASE}/connections/${id}`, { method: "DELETE" }), params({ id })),
    );
    expect((await list(id)).status).toBe(404);
  });
});
