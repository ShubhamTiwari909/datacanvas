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
const share = (id: string, level: string) =>
  putSharing(
    new Request(`${BASE}/api/connections/${id}/claude`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Host: "127.0.0.1:4747", ...cookie },
      body: JSON.stringify({ level }),
    }),
    params({ id }),
  );
const rpc = (method: string, params?: unknown, id = 1) => ({ jsonrpc: "2.0", id, method, params });
const post = (body: unknown, headers: Record<string, string> = {}, token: string | null = MCP) =>
  mcpPost(
    new Request(`${BASE}/mcp`, {
      method: "POST",
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
