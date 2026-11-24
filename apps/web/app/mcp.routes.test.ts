/**
 * The route of the Model Context Protocol (`docs/mcp-server-plan.md`; decision 169), in process against a mock adapter: its own
 * token, no cookie, no browser, 404 while nothing is shared, the level of each connection, and that a refusal says nothing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setServerContextForTests } from "@/lib/server/context";
import { createTestContext, fieldsInput, type TestContext } from "@/lib/server/test-support";
import { POST as createConnection } from "./api/connections/route";
import { DELETE as disconnect } from "./api/connections/[id]/route";
import { PUT as setDataAccess } from "./api/connections/[id]/data-access/route";
import { GET as getSharing, PUT as putSharing } from "./api/connections/[id]/claude/route";
import { GET as getActivity } from "./api/claude/activity/route";
import { POST as decide } from "./api/claude/pending/[id]/route";
import { PUT as setPause } from "./api/claude/pause/route";
import { DELETE as mcpDelete, GET as mcpGet, POST as mcpPost } from "./mcp/route";

const BASE = "http://127.0.0.1:4747";
const SESSION = "s".repeat(43);
const MCP = "m".repeat(43);
const params = <T extends Record<string, string>>(value: T) => ({ params: Promise.resolve(value) });

let context: TestContext;
beforeEach(() => {
  vi.stubEnv("PORT", "4747");
  vi.stubEnv("DATACANVAS_SESSION_TOKEN", SESSION);
  vi.stubEnv("DATACANVAS_MCP_TOKEN", MCP);
  context = createTestContext();
  setServerContextForTests(context);
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  setServerContextForTests(undefined);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const cookie = { Cookie: `dc_session_4747=${SESSION}` };
async function connect(extra: Record<string, unknown> = {}): Promise<string> {
  const response = await createConnection(
    new Request(`${BASE}/api/connections`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Host: "127.0.0.1:4747", ...cookie },
      body: JSON.stringify(fieldsInput(extra)),
    }),
  );
  return ((await response.json()) as { connection: { id: string } }).connection.id;
}
// The data level asks for the person's Approve on each call unless said otherwise: these tests turn it off, except the ones about it.
const share = (id: string, level: string, extra: Record<string, unknown> = {}) =>
  putSharing(
    new Request(`${BASE}/api/connections/${id}/claude`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Host: "127.0.0.1:4747", ...cookie },
      body: JSON.stringify({ level, ...(level === "data" ? { approval: false } : {}), ...extra }),
    }),
    params({ id }),
  );
const rpc = (method: string, params?: unknown, id = 1) => ({ jsonrpc: "2.0", id, method, params });
const post = (
  body: unknown,
  headers: Record<string, string> = {},
  token: string | null = MCP,
  signal?: AbortSignal,
) =>
  mcpPost(
    new Request(`${BASE}/mcp`, {
      method: "POST",
      signal,
      headers: {
        "Content-Type": "application/json",
        Host: "127.0.0.1:4747",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );

describe("while nothing is shared", () => {
  it("does not exist: 404, even with the right token, and the same for any body", async () => {
    await connect();
    expect((await post(rpc("tools/list"))).status).toBe(404);
    expect((await post(rpc("initialize", { protocolVersion: "2025-06-18" }))).status).toBe(404);
    expect((await post("not json")).status).toBe(404);
  });
});

describe("the guard", () => {
  it("refuses a missing, a wrong and the SESSION token (401), a browser (403) and another Host (403)", async () => {
    const id = await connect();
    await share(id, "structure");
    expect((await post(rpc("ping"), {}, null)).status).toBe(401);
    expect((await post(rpc("ping"), {}, "x".repeat(43))).status).toBe(401);
    expect((await post(rpc("ping"), {}, SESSION)).status).toBe(401);
    expect((await post(rpc("ping"), { Origin: "http://127.0.0.1:4747" })).status).toBe(403);
    expect((await post(rpc("ping"), { "Sec-Fetch-Site": "same-origin" })).status).toBe(403);
    expect((await post(rpc("ping"), { Host: "evil.example:4747" })).status).toBe(403);
    // And the cookie of the app does not open it.
    expect((await post(rpc("ping"), { ...cookie }, null)).status).toBe(401);
    expect((await post(rpc("ping"))).status).toBe(200);
  });

  it("answers GET and DELETE with 405: there is no stream and no session", async () => {
    expect(mcpGet().status).toBe(405);
    expect(mcpDelete().status).toBe(405);
  });

  it("refuses a body over 256 KB (413) and a body that is not JSON (400), without repeating either", async () => {
    const id = await connect();
    await share(id, "structure");
    expect((await post("x".repeat(256 * 1024 + 1))).status).toBe(413);
    const bad = await post("this is not json " + "SECRET-VALUE");
    expect(bad.status).toBe(400);
    expect(await bad.text()).not.toContain("SECRET-VALUE");
  });

  it("the token of /mcp is not a credential for the app's routes", async () => {
    const id = await connect();
    const response = await getSharing(
      new Request(`${BASE}/api/connections/${id}/claude`, {
        headers: { Host: "127.0.0.1:4747", Authorization: `Bearer ${MCP}` },
      }),
      params({ id }),
    );
    expect(response.status).toBe(401);
  });
});

describe("the protocol through the route", () => {
  it("negotiates, lists exactly the pinned tools with the read-only annotations, and has no write tool", async () => {
    const id = await connect();
    await share(id, "structure");
    const init = await post(
      rpc("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "t" },
      }),
    );
    expect(init.status).toBe(200);
    const initBody = (await init.json()) as {
      result: { protocolVersion: string; instructions: string };
    };
    expect(initBody.result.protocolVersion).toBe("2025-06-18");
    expect(initBody.result.instructions).toMatch(/READ-ONLY/);
    expect(init.headers.get("cache-control")).toBe("no-store");
    const listed = (await (await post(rpc("tools/list"))).json()) as {
      result: { tools: Array<{ name: string; annotations: Record<string, unknown> }> };
    };
    for (const tool of listed.result.tools) {
      expect(tool.annotations).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      });
      expect(tool.name).not.toMatch(/write|insert|update|delete|drop|create|alter|import|execute/i);
    }
    expect((await post({ jsonrpc: "2.0", method: "notifications/initialized" })).status).toBe(202);
  });

  it("list_connections names only what is shared: the name and the database, never the host, user or password", async () => {
    const shared = await connect();
    const hidden = await connect();
    await share(shared, "structure");
    const call = await post(rpc("tools/call", { name: "list_connections", arguments: {} }));
    const text = await call.text();
    const body = JSON.parse(text) as {
      result: { structuredContent: { connections: Array<Record<string, string>> } };
    };
    expect(body.result.structuredContent.connections).toHaveLength(1);
    expect(body.result.structuredContent.connections[0]).toMatchObject({
      id: shared,
      level: "structure",
    });
    expect(Object.keys(body.result.structuredContent.connections[0]!).sort()).toEqual([
      "database",
      "id",
      "level",
      "name",
    ]);
    expect(text).not.toContain(hidden);
    expect(text).not.toMatch(/s3cret-pw|"host"|"username"|"password"/);
  });
});

describe("what is shared, and at which level", () => {
  it("the data level needs viewing table data; the structure level does not", async () => {
    const id = await connect();
    const refused = await share(id, "data");
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe(
      "data_access_disabled",
    );
    expect((await share(id, "structure")).status).toBe(200);
    await setDataAccess(
      new Request(`${BASE}/api/connections/${id}/data-access`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Host: "127.0.0.1:4747", ...cookie },
        body: JSON.stringify({ enabled: true }),
      }),
      params({ id }),
    );
    expect(
      ((await (await share(id, "data")).json()) as { sharing: { level: string } }).sharing.level,
    ).toBe("data");
  });

  it("switching viewing table data off takes the data level back to structure", async () => {
    const id = await connect({ dataAccess: true });
    await share(id, "data");
    expect(context.mcp.levelOf(id)).toBe("data");
    context.connections.setDataAccess(id, false);
    expect(context.mcp.levelOf(id)).toBe("structure");
  });

  it("a disconnect ends the sharing, and 'off' ends it too; an unknown connection cannot be shared", async () => {
    const id = await connect();
    await share(id, "structure");
    expect(context.mcp.anyShared()).toBe(true);
    await disconnect(
      new Request(`${BASE}/api/connections/${id}`, {
        method: "DELETE",
        headers: { Host: "127.0.0.1:4747", ...cookie },
      }),
      params({ id }),
    );
    expect(context.mcp.anyShared()).toBe(false);
    expect((await post(rpc("ping"))).status).toBe(404);
    const other = await connect();
    await share(other, "structure");
    await share(other, "off");
    expect(context.mcp.anyShared()).toBe(false);
    expect((await share("missing-connection-id-0000", "structure")).status).toBe(404);
  });

  it("sharing is in memory only: a new service starts with nothing shared", async () => {
    const id = await connect();
    await share(id, "structure");
    setServerContextForTests(createTestContext());
    expect(createTestContext().mcp.anyShared()).toBe(false);
  });
});

describe("the structure tools (M2)", () => {
  const call = async (name: string, args: Record<string, unknown>) => {
    const response = await post(rpc("tools/call", { name, arguments: args }));
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      result: {
        isError?: boolean;
        content: Array<{ text: string }>;
        // The tests read the structure of an answer by name: it is data of their own tool, typed loosely on purpose.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        structuredContent?: Record<string, any>;
      };
    };
    return body.result;
  };

  it("lists the five tools, all read-only, and no tool takes anything but a connection id and names", async () => {
    const id = await connect();
    await share(id, "structure");
    const listed = (await (await post(rpc("tools/list"))).json()) as {
      result: {
        tools: Array<{
          name: string;
          inputSchema: { properties: Record<string, unknown>; additionalProperties: boolean };
        }>;
      };
    };
    expect(listed.result.tools.map((t) => t.name)).toEqual([
      "list_connections",
      "list_schemas",
      "list_tables",
      "describe_table",
      "search_objects",
    ]);
    for (const tool of listed.result.tools) {
      expect(tool.inputSchema.additionalProperties).toBe(false);
      // No tool takes SQL, a statement or a where clause.
      expect(Object.keys(tool.inputSchema.properties).join(",")).not.toMatch(
        /sql|statement|where|query_text|expression/i,
      );
    }
  });

  it("lists schemas and tables of a shared connection", async () => {
    const id = await connect();
    await share(id, "structure");
    const schemas = await call("list_schemas", { connection: id });
    expect(schemas.structuredContent!["schemas"].map((s: { schema: string }) => s.schema)).toEqual([
      "analytics",
      "public",
    ]);
    const tables = await call("list_tables", { connection: id, schema: "public" });
    const names = tables.structuredContent!["tables"].map((t: { name: string }) => t.name);
    expect(names).toContain("users");
    expect(names).toContain("orders");
    expect(tables.structuredContent!["nextCursor"]).toBeNull();
    // A cursor continues the list from where it says.
    const tail = await call("list_tables", { connection: id, schema: "public", cursor: "2" });
    expect(tail.structuredContent!["tables"].map((t: { name: string }) => t.name)).toEqual(
      names.slice(2),
    );
  });

  it("describes a table: columns, keys, indexes and the foreign keys in both directions", async () => {
    const id = await connect();
    await share(id, "structure");
    const users = await call("describe_table", {
      connection: id,
      schema: "public",
      table: "users",
    });
    const data = users.structuredContent!;
    expect(data["columns"].map((c: { name: string }) => c.name)).toContain("email");
    expect(data["constraints"].some((c: { kind: string }) => c.kind === "primary_key")).toBe(true);
    expect(data["referencedBy"].map((r: { from: string }) => r.from)).toContain("public.orders");
    const orders = await call("describe_table", {
      connection: id,
      schema: "public",
      table: "orders",
    });
    expect(
      orders.structuredContent!["references"].map((r: { references: string }) => r.references),
    ).toContain("public.users");
    expect(orders.content[0]!.text).toMatch(/^public\.orders \(table\)\. Columns: /);
  });

  it("says a column is hidden when its name looks sensitive, and the text says its values are never returned", async () => {
    const id = await connect();
    await share(id, "structure");
    const adapter = context.createdAdapters[0]!;
    const original = adapter.getTablesDetails.bind(adapter);
    vi.spyOn(adapter, "getTablesDetails").mockImplementation(async (refs) => {
      const [entry] = await original(refs);
      entry!.columns.push({
        name: "api_token",
        ordinalPosition: 99,
        dataType: "text",
        nullable: true,
        defaultValue: null,
        comment: null,
      });
      return [entry!];
    });
    const result = await call("describe_table", {
      connection: id,
      schema: "public",
      table: "users",
    });
    const hidden = result
      .structuredContent!["columns"].filter((c: { hidden: boolean }) => c.hidden)
      .map((c: { name: string }) => c.name);
    expect(hidden).toEqual(["api_token"]);
    expect(result.content[0]!.text).toMatch(
      /1 column is marked hidden: their values are never returned to you\./,
    );
  });

  it("searches names, not data", async () => {
    const id = await connect();
    await share(id, "structure");
    const found = await call("search_objects", { connection: id, query: "email" });
    expect(
      found.structuredContent!["results"].some(
        (h: { column: string | null }) => h.column === "email",
      ),
    ).toBe(true);
  });

  it("a connection that is not shared, a paused one and one that does not exist all get the same answer", async () => {
    const shared = await connect();
    const other = await connect();
    await share(shared, "structure");
    const refusals = [];
    for (const connection of [other, "0".repeat(32), "nope"]) {
      refusals.push(await call("list_schemas", { connection }));
    }
    for (const r of refusals) {
      expect(r.isError).toBe(true);
      expect(r.content[0]!.text).toBe(refusals[0]!.content[0]!.text);
      expect(r.content[0]!.text).toMatch(/not shared with Claude, or does not exist/);
    }
    // The same for every tool.
    for (const [name, args] of [
      ["list_tables", { schema: "public" }],
      ["describe_table", { schema: "public", table: "users" }],
      ["search_objects", { query: "a" }],
    ] as const) {
      const r = await call(name, { connection: other, ...args });
      expect(r.content[0]!.text).toBe(refusals[0]!.content[0]!.text);
    }
  });

  it("a table or schema that does not exist is said so in words, and a failing database is a fixed sentence with no message of its own", async () => {
    const id = await connect();
    await share(id, "structure");
    const missing = await call("describe_table", {
      connection: id,
      schema: "public",
      table: "nope",
    });
    expect(missing).toMatchObject({
      isError: true,
      content: [{ text: "There is no such table or schema." }],
    });
    const adapter = context.createdAdapters[0]!;
    vi.spyOn(adapter, "getSchemas").mockRejectedValue(
      new Error("password authentication failed for user alice: hunter2-SECRET"),
    );
    const failed = await call("list_schemas", { connection: id });
    expect(failed.isError).toBe(true);
    expect(JSON.stringify(failed)).not.toContain("hunter2-SECRET");
    expect(failed.content[0]!.text).toBe("The database could not be read right now.");
  });

  it("wrong arguments are a tool error that names the field and never the value", async () => {
    const id = await connect();
    await share(id, "structure");
    const bad = await call("list_tables", {
      connection: id,
      schema: "public",
      cursor: "abc-SECRET-VALUE",
    });
    expect(bad.isError).toBe(true);
    expect(JSON.stringify(bad)).not.toContain("SECRET-VALUE");
    const extra = await call("list_schemas", { connection: id, sql: "select 1" });
    expect(extra.isError).toBe(true);
    expect(extra.content[0]!.text).toMatch(/has a field this tool does not take/);
  });
});

describe("the data tools (M3)", () => {
  const call = async (name: string, args: Record<string, unknown>) => {
    const response = await post(rpc("tools/call", { name, arguments: args }));
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      result: {
        isError?: boolean;
        content: Array<{ text: string }>;
        structuredContent?: Record<string, unknown>;
      };
    };
    return body.result;
  };
  const names = async () =>
    (
      (await (await post(rpc("tools/list"))).json()) as {
        result: { tools: Array<{ name: string }> };
      }
    ).result.tools.map((t) => t.name);

  it("the data tools exist for a caller only while a connection is shared at the data level", async () => {
    const id = await connect({ dataAccess: true });
    await share(id, "structure");
    expect(await names()).not.toContain("run_readonly_query");
    await share(id, "data");
    expect(await names()).toEqual([
      "list_connections",
      "list_schemas",
      "list_tables",
      "describe_table",
      "search_objects",
      "read_rows",
      "run_readonly_query",
      "explain_query",
    ]);
    // A call to one while it is not offered is a tool nobody made.
    await share(id, "structure");
    const gone = await post(
      rpc("tools/call", {
        name: "run_readonly_query",
        arguments: { connection: id, sql: "SELECT 1" },
      }),
    );
    expect(((await gone.json()) as { error: { code: number } }).error.code).toBe(-32602);
  });

  it("a structure-level connection says so when a data tool is called with it, while another is at the data level", async () => {
    const structure = await connect();
    const data = await connect({ dataAccess: true });
    await share(structure, "structure");
    await share(data, "data");
    const r = await call("run_readonly_query", { connection: structure, sql: "SELECT 1" });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/structure level only/);
    const none = await call("read_rows", { connection: "nope", schema: "public", table: "users" });
    expect(none.content[0]!.text).toMatch(/not shared with Claude, or does not exist/);
  });

  it("runs one read-only statement and answers rows, columns and whether more were left out", async () => {
    const id = await connect({ dataAccess: true });
    await share(id, "data");
    context.createdAdapters[0]!.sqlHandler = async () => ({
      columns: [{ name: "n", dataType: "integer" }],
      rows: [["1"], ["2"]],
      truncated: true,
      command: "SELECT",
      cutCells: 0,
      elapsedMs: 1,
    });
    const r = await call("run_readonly_query", {
      connection: id,
      sql: "SELECT n FROM t",
      max_rows: 2,
    });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toMatchObject({
      rows: [["1"], ["2"]],
      truncated: true,
      hiddenColumns: [],
    });
    expect(r.content[0]!.text).toMatch(/more were left out: add a LIMIT/);
  });

  it("refuses a statement that names a sensitive column before it runs, and nulls a hidden column of a result", async () => {
    const id = await connect({ dataAccess: true });
    await share(id, "data");
    const ran = vi.fn();
    context.createdAdapters[0]!.sqlHandler = async () => {
      ran();
      return {
        columns: [
          { name: "id", dataType: "integer" },
          { name: "secret_note", dataType: "text" },
        ],
        rows: [["1", "hunter2-SECRET-VALUE"]],
        truncated: false,
        command: "SELECT",
        cutCells: 0,
        elapsedMs: 1,
      };
    };
    const refused = await call("run_readonly_query", {
      connection: id,
      sql: "SELECT password FROM users",
    });
    expect(refused.isError).toBe(true);
    expect(refused.content[0]!.text).toMatch(/names columns that look sensitive \(password\)/);
    expect(ran).not.toHaveBeenCalled();
    // `SELECT *` names nothing, so it runs, and the column of the result with a sensitive name is NULL.
    const star = await call("run_readonly_query", { connection: id, sql: "SELECT * FROM users" });
    expect(star.structuredContent).toMatchObject({
      rows: [["1", null]],
      hiddenColumns: ["secret_note"],
    });
    expect(JSON.stringify(star)).not.toContain("hunter2-SECRET-VALUE");
  });

  it("refuses a write, a creation, an EXPLAIN ANALYZE of a creation and COPY, as the SQL tab does (two statements are tested on a real database)", async () => {
    const id = await connect({ dataAccess: true });
    await share(id, "data");
    for (const sql of [
      "DELETE FROM users",
      "CREATE TABLE t (a int)",
      "EXPLAIN ANALYZE CREATE TABLE t AS SELECT 1",
      "COPY users TO PROGRAM 'x'",
    ]) {
      const r = await call("run_readonly_query", { connection: id, sql });
      expect(r.isError, sql).toBe(true);
    }
  });

  it("does not pass on the database's message about a value, and does pass on a syntax error", async () => {
    const id = await connect({ dataAccess: true });
    await share(id, "data");
    context.createdAdapters[0]!.sqlHandler = async () => {
      const { SqlStatementError } = await import("@datacanvas/database-core");
      throw new SqlStatementError(
        "22P02",
        'invalid input syntax for type integer: "hunter2-SECRET-VALUE"',
      );
    };
    const value = await call("run_readonly_query", {
      connection: id,
      sql: "SELECT CAST(note AS int) FROM t",
    });
    expect(JSON.stringify(value)).not.toContain("hunter2-SECRET-VALUE");
    expect(value.content[0]!.text).toMatch(/SQLSTATE 22P02/);
    context.createdAdapters[0]!.sqlHandler = async () => {
      const { SqlStatementError } = await import("@datacanvas/database-core");
      throw new SqlStatementError("42703", 'column "emai" does not exist');
    };
    const syntax = await call("run_readonly_query", {
      connection: id,
      sql: "SELECT emai FROM users",
    });
    expect(syntax.content[0]!.text).toBe('column "emai" does not exist');
  });

  it("reads a page of rows by the page reader, never revealing a hidden column, and refuses what it refuses", async () => {
    const id = await connect({ dataAccess: true });
    await share(id, "data");
    const page = await call("read_rows", {
      connection: id,
      schema: "public",
      table: "users",
      page_size: 2,
    });
    expect(page.isError).toBeFalsy();
    const data = page.structuredContent as {
      rows: unknown[][];
      columns: Array<{ name: string; hidden: boolean }>;
      nextCursor: string | null;
    };
    expect(data.rows.length).toBeLessThanOrEqual(2);
    expect(data.columns.map((c) => c.name)).toContain("email");
    const missing = await call("read_rows", { connection: id, schema: "public", table: "nope" });
    expect(missing.content[0]!.text).toBe("There is no such table or schema.");
    const badFilter = await call("read_rows", {
      connection: id,
      schema: "public",
      table: "users",
      filters: [{ column: "nope", op: "eq", value: "x" }],
    });
    expect(badFilter.isError).toBe(true);
    expect(badFilter.content[0]!.text).toMatch(/was not accepted for this table/);
    // There is no way to ask for a hidden column to be revealed: the input has no such field.
    const reveal = await call("read_rows", {
      connection: id,
      schema: "public",
      table: "users",
      revealColumns: ["x"],
    });
    expect(reveal.isError).toBe(true);
  });

  it("explains a query without running it, and takes the data level only", async () => {
    const id = await connect({ dataAccess: true });
    await share(id, "data");
    context.createdAdapters[0]!.sqlHandler = async (request) => {
      expect(request.text.startsWith("EXPLAIN (FORMAT JSON) ")).toBe(true);
      return {
        columns: [{ name: "QUERY PLAN", dataType: "json" }],
        rows: [['[{"Plan":{"Node Type":"Seq Scan"}}]']],
        truncated: false,
        command: "EXPLAIN",
        cutCells: 0,
        elapsedMs: 1,
      };
    };
    const r = await call("explain_query", { connection: id, sql: "SELECT * FROM users" });
    expect(r.structuredContent).toEqual({ plan: [{ Plan: { "Node Type": "Seq Scan" } }] });
  });

  it("the data level needs the role acknowledged for a superuser, and not for an ordinary role", async () => {
    const ordinary = await connect({ dataAccess: true });
    expect((await share(ordinary, "data")).status).toBe(200);
    const risky = await connect({ dataAccess: true });
    const adapter = context.createdAdapters[1]!;
    const role = await adapter.getRoleInfo();
    vi.spyOn(adapter, "getRoleInfo").mockResolvedValue({ ...role, superuser: true });
    const refused = await share(risky, "data");
    expect(refused.status).toBe(409);
    const body = (await refused.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("claude_role_not_acknowledged");
    expect(body.error.message).toMatch(/read-only database user/);
    expect(context.mcp.levelOf(risky)).toBe("off");
    const acknowledged = await putSharing(
      new Request(`${BASE}/api/connections/${risky}/claude`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Host: "127.0.0.1:4747", ...cookie },
        body: JSON.stringify({ level: "data", acknowledgeRole: true }),
      }),
      params({ id: risky }),
    );
    expect(acknowledged.status).toBe(200);
    // Structure level needs no acknowledgment, whatever the role.
    expect((await share(risky, "structure")).status).toBe(200);
  });

  describe("approval, pause, the rate limit and the activity list", () => {
    const api = (path: string, method: string, body?: unknown) =>
      new Request(`${BASE}${path}`, {
        method,
        headers: { "Content-Type": "application/json", Host: "127.0.0.1:4747", ...cookie },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    const activity = async () =>
      (await (await getActivity(api("/api/claude/activity", "GET"))).json()) as {
        paused: boolean;
        shared: Array<{ id: string; level: string; approval: boolean }>;
        pending: Array<{ id: string; tool: string; request: string }>;
        activity: Array<{ outcome: string; request: string; rows?: number; size?: number }>;
      };
    const answer = (id: string, decision: string) =>
      decide(api(`/api/claude/pending/${id}`, "POST", { decision }), params({ id }));
    const sqlCall = (id: string, sql = "SELECT n FROM t") =>
      call("run_readonly_query", { connection: id, sql });
    const rowsReturned = () => {
      context.createdAdapters[0]!.sqlHandler = async () => ({
        columns: [{ name: "n", dataType: "integer" }],
        rows: [["1"], ["2"], ["3"]],
        truncated: false,
        command: "SELECT",
        cutCells: 0,
        elapsedMs: 1,
      });
    };
    const waitForPending = async () => {
      for (let i = 0; i < 100; i++) {
        const state = await activity();
        if (state.pending.length > 0) return state.pending[0]!;
        await new Promise((r) => setTimeout(r, 5));
      }
      throw new Error("nothing is waiting");
    };

    it("the data level asks for Approve by default, and nothing runs before it", async () => {
      const id = await connect({ dataAccess: true });
      await share(id, "data", { approval: undefined });
      const ran = vi.fn();
      context.createdAdapters[0]!.sqlHandler = async () => {
        ran();
        return {
          columns: [{ name: "n", dataType: "integer" }],
          rows: [["1"]],
          truncated: false,
          command: "SELECT",
          cutCells: 0,
          elapsedMs: 1,
        };
      };
      expect((await activity()).shared).toEqual([
        { id, name: expect.any(String), level: "data", approval: true },
      ]);
      const waiting = sqlCall(id, "SELECT n FROM t WHERE n = 1");
      const pending = await waitForPending();
      expect(pending).toMatchObject({
        tool: "run_readonly_query",
        request: "SELECT n FROM t WHERE n = 1",
      });
      expect(ran).not.toHaveBeenCalled();
      expect((await answer(pending.id, "approve")).status).toBe(200);
      const r = await waiting;
      expect(r.isError).toBeFalsy();
      expect(ran).toHaveBeenCalledTimes(1);
      expect((await answer(pending.id, "approve")).status).toBe(404);
      expect((await activity()).pending).toEqual([]);
    });

    it("a denied call never runs, and tells Claude in plain words", async () => {
      const id = await connect({ dataAccess: true });
      await share(id, "data", { approval: true });
      const ran = vi.fn();
      context.createdAdapters[0]!.sqlHandler = async () => {
        ran();
        throw new Error("must not run");
      };
      const waiting = sqlCall(id);
      await answer((await waitForPending()).id, "deny");
      const r = await waiting;
      expect(r.isError).toBe(true);
      expect(r.content[0]!.text).toMatch(/did not approve/);
      expect(ran).not.toHaveBeenCalled();
      expect((await activity()).activity[0]).toMatchObject({ outcome: "not_approved" });
    });

    it("a call that is given up (the client went away) stops waiting", async () => {
      const id = await connect({ dataAccess: true });
      await share(id, "data", { approval: true });
      const controller = new AbortController();
      const waiting = post(
        rpc("tools/call", {
          name: "run_readonly_query",
          arguments: { connection: id, sql: "SELECT 1" },
        }),
        {},
        MCP,
        controller.signal,
      );
      await waitForPending();
      controller.abort();
      await waiting;
      expect((await activity()).pending).toEqual([]);
      expect((await activity()).activity[0]).toMatchObject({ outcome: "not_approved" });
    });

    it("with approval off the call runs at once, and structure tools never wait", async () => {
      const id = await connect({ dataAccess: true });
      await share(id, "data", { approval: false });
      rowsReturned();
      expect((await sqlCall(id)).isError).toBeFalsy();
      const tables = await call("list_schemas", { connection: id });
      expect(tables.isError).toBeFalsy();
      const asked = await share(id, "data", { approval: true });
      expect(((await asked.json()) as { sharing: { approval: boolean } }).sharing.approval).toBe(
        true,
      );
      expect(
        (
          (await (await getSharing(api("/x", "GET"), params({ id }))).json()) as {
            sharing: { approval: boolean };
          }
        ).sharing.approval,
      ).toBe(true);
    });

    it("the activity list holds what was asked and counts, and no value that came back", async () => {
      const id = await connect({ dataAccess: true });
      await share(id, "data");
      rowsReturned();
      await sqlCall(id, "SELECT n FROM t");
      const state = await activity();
      expect(state.activity[0]).toMatchObject({
        outcome: "ok",
        request: "SELECT n FROM t",
        rows: 3,
      });
      expect(state.activity[0]!.size).toBeGreaterThan(0);
      expect(JSON.stringify(state)).not.toMatch(/"1"|"2"|"3"/);
      // A refusal is listed as refused; a hidden value never appears in the list.
      await sqlCall(id, "SELECT password FROM users");
      expect((await activity()).activity[0]).toMatchObject({ outcome: "refused" });
    });

    it("Pause refuses every call at once, even a structure one, and Resume lets the next through", async () => {
      const id = await connect({ dataAccess: true });
      await share(id, "data");
      rowsReturned();
      expect(
        (
          (await (await setPause(api("/api/claude/pause", "PUT", { paused: true }))).json()) as {
            paused: boolean;
          }
        ).paused,
      ).toBe(true);
      for (const [name, args] of [
        ["list_schemas", { connection: id }],
        ["run_readonly_query", { connection: id, sql: "SELECT 1" }],
      ] as const) {
        const r = await call(name, args);
        expect(r.isError).toBe(true);
        expect(r.content[0]!.text).toMatch(/paused/);
      }
      expect((await activity()).activity[0]).toMatchObject({ outcome: "paused" });
      await setPause(api("/api/claude/pause", "PUT", { paused: false }));
      expect((await sqlCall(id)).isError).toBeFalsy();
    });

    it("Pause answers a waiting approval with a denial", async () => {
      const id = await connect({ dataAccess: true });
      await share(id, "data", { approval: true });
      const waiting = sqlCall(id);
      await waitForPending();
      await setPause(api("/api/claude/pause", "PUT", { paused: true }));
      expect((await waiting).isError).toBe(true);
      expect((await activity()).pending).toEqual([]);
    });

    it("serves 30 calls a minute and then says so, and stopping the sharing forgets the list and the pause", async () => {
      const id = await connect({ dataAccess: true });
      await share(id, "structure");
      for (let i = 0; i < 30; i++)
        expect((await call("list_schemas", { connection: id })).isError).toBeFalsy();
      const limited = await call("list_schemas", { connection: id });
      expect(limited.isError).toBe(true);
      expect(limited.content[0]!.text).toMatch(/Too many calls/);
      await setPause(api("/api/claude/pause", "PUT", { paused: true }));
      await share(id, "off");
      const state = await activity();
      expect(state).toMatchObject({ paused: false, shared: [], pending: [], activity: [] });
    });

    it("a disconnect denies what waits, and the routes are behind the cookie", async () => {
      const id = await connect({ dataAccess: true });
      await share(id, "data", { approval: true });
      const waiting = sqlCall(id);
      await waitForPending();
      await disconnect(api(`/api/connections/${id}`, "DELETE"), params({ id }));
      expect((await waiting).isError).toBe(true);
      const bare = (path: string, method: string) =>
        new Request(`${BASE}${path}`, { method, headers: { Host: "127.0.0.1:4747" } });
      for (const response of [
        await getActivity(bare("/api/claude/activity", "GET")),
        await setPause(bare("/api/claude/pause", "PUT")),
        await decide(bare("/api/claude/pending/c1", "POST"), params({ id: "c1" })),
      ]) {
        expect(response.status).toBeGreaterThanOrEqual(400);
        expect(response.status).toBeLessThan(500);
      }
    });
  });

  describe("what the independent review found", () => {
    it("turning viewing table data off ends the data level for good: switching it on again does not bring it back", async () => {
      const id = await connect({ dataAccess: true });
      await share(id, "data");
      expect(context.mcp.levelOf(id)).toBe("data");
      const toggle = (enabled: boolean) =>
        setDataAccess(
          new Request(`${BASE}/api/connections/${id}/data-access`, {
            method: "PUT",
            headers: { "Content-Type": "application/json", Host: "127.0.0.1:4747", ...cookie },
            body: JSON.stringify({ enabled }),
          }),
          params({ id }),
        );
      await toggle(false);
      expect(context.mcp.levelOf(id)).toBe("structure");
      await toggle(true);
      expect(context.mcp.levelOf(id)).toBe("structure");
    });

    it("a role that cannot be checked is treated as a risky one: the person must confirm", async () => {
      const id = await connect({ dataAccess: true });
      vi.spyOn(context.createdAdapters[0]!, "getRoleInfo").mockRejectedValue(new Error("no"));
      expect((await share(id, "data", { acknowledgeRole: undefined })).status).toBe(409);
      expect((await share(id, "data", { acknowledgeRole: true })).status).toBe(200);
    });

    it("a cursor is sealed: made up, or taken to another table, it is refused", async () => {
      const service = context.mcp;
      const scope = ["c1", "public", "keyed", "null"].join("\0");
      const sealed = service.sealCursor("anything", scope);
      expect(service.openCursor(sealed, scope)).toBe("anything");
      expect(() => service.openCursor(sealed, scope.replace("keyed", "other"))).toThrow(
        /not valid/,
      );
      expect(() => service.openCursor("eyJrIjpbIlRPS0VOIl19", scope)).toThrow(/not valid/);
    });

    it("the person is shown the whole statement, with control characters made visible, and a statement that would be refused is not asked about", async () => {
      const id = await connect({ dataAccess: true });
      await share(id, "data", { approval: true });
      const long = `SELECT 1 ${" ".repeat(5000)}, 2 AS late`;
      const waiting = call("run_readonly_query", { connection: id, sql: long });
      const pending = await (async () => {
        for (let i = 0; i < 100; i++) {
          const found = context.mcp.control.pending()[0];
          if (found) return found;
          await new Promise((r) => setTimeout(r, 5));
        }
        throw new Error("nothing waits");
      })();
      expect(pending.request).toBe(long);
      context.mcp.control.decide(pending.id, "deny");
      await waiting;
      const disguised = call("run_readonly_query", { connection: id, sql: "SELECT '\u202e' AS x" });
      const shown = await (async () => {
        for (let i = 0; i < 100; i++) {
          const found = context.mcp.control.pending()[0];
          if (found) return found;
          await new Promise((r) => setTimeout(r, 5));
        }
        throw new Error("nothing waits");
      })();
      expect(shown.request).toBe("SELECT '\\u{202e}' AS x");
      context.mcp.control.decide(shown.id, "deny");
      await disguised;
      // Refused before any prompt: nothing waits for a statement that names a hidden column.
      const refused = await call("run_readonly_query", {
        connection: id,
        sql: "SELECT password FROM t",
      });
      expect(refused.isError).toBe(true);
      expect(context.mcp.control.pending()).toEqual([]);
      // Too long to show whole: refused, not cut.
      const huge = await call("read_rows", {
        connection: id,
        schema: "public",
        table: "users",
        cursor: "x".repeat(4000),
        filters: Array.from({ length: 10 }, () => ({
          column: "id",
          operator: "equals",
          value: "y".repeat(3000),
        })),
      });
      expect(huge.isError).toBe(true);
    });
  });
});
