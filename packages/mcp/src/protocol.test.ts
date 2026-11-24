import { z } from "zod";
import { describe, expect, it } from "vitest";
import { MAX_BATCH } from "./jsonrpc.js";
import { MAX_RESULT_CHARS, SUPPORTED_PROTOCOL_VERSIONS, createMcpServer } from "./protocol.js";
import { READ_ONLY, ToolError, type ToolDefinition } from "./tools.js";

interface Ctx {
  offered: string[];
}

const SECRET = "hunter2-SECRET-VALUE";

const tools: Array<ToolDefinition<Ctx>> = [
  {
    name: "echo",
    title: "Echo",
    description: "Says what it was given.",
    input: z.strictObject({
      word: z.string().min(1).max(20),
      times: z.number().int().min(1).max(3).optional(),
    }),
    annotations: READ_ONLY,
    run: async (args) => {
      const { word, times } = args as { word: string; times?: number };
      return { text: word.repeat(times ?? 1), data: { word, times: times ?? 1 } };
    },
  },
  {
    name: "refuses",
    title: "Refuses",
    description: "Always refuses, with words for the model.",
    input: z.strictObject({}),
    annotations: READ_ONLY,
    run: async () => {
      throw new ToolError("This table has a hidden column: api_token.");
    },
  },
  {
    name: "breaks",
    title: "Breaks",
    description: "Throws an error with a value in it.",
    input: z.strictObject({}),
    annotations: READ_ONLY,
    run: async () => {
      throw new Error(`database said: ${SECRET}`);
    },
  },
  {
    name: "huge",
    title: "Huge",
    description: "Answers too much.",
    input: z.strictObject({}),
    annotations: READ_ONLY,
    run: async () => ({ text: "x".repeat(MAX_RESULT_CHARS + 1) }),
  },
];

const server = createMcpServer<Ctx>({
  name: "test",
  title: "Test",
  version: "1.0.0",
  instructions: "Read only.",
  tools: (ctx) => tools.filter((t) => ctx.offered.includes(t.name)),
});
const ctx: Ctx = { offered: ["echo", "refuses", "breaks", "huge"] };
const call = (body: unknown, context: Ctx = ctx) => server.handle(body, context);
const rpc = (method: string, params?: unknown, id: number | string = 1) => ({
  jsonrpc: "2.0",
  id,
  method,
  params,
});

describe("initialize", () => {
  it("answers with the version asked for when it is supported, and the newest when it is not", async () => {
    for (const version of SUPPORTED_PROTOCOL_VERSIONS) {
      const r = await call(
        rpc("initialize", { protocolVersion: version, capabilities: {}, clientInfo: {} }),
      );
      expect(r).toMatchObject({
        status: 200,
        body: { id: 1, result: { protocolVersion: version } },
      });
    }
    const other = await call(rpc("initialize", { protocolVersion: "1999-01-01" }));
    expect(other).toMatchObject({
      body: { result: { protocolVersion: SUPPORTED_PROTOCOL_VERSIONS[0] } },
    });
  });

  it("declares tools and nothing else, and says what the server is", async () => {
    const r = await call(rpc("initialize", { protocolVersion: "2025-06-18" }));
    const result = (r.body as { result: Record<string, unknown> }).result;
    expect(result["capabilities"]).toEqual({ tools: { listChanged: false } });
    expect(result["serverInfo"]).toEqual({ name: "test", title: "Test", version: "1.0.0" });
    expect(result["instructions"]).toBe("Read only.");
  });

  it("refuses parameters that are not parameters, with a fixed sentence", async () => {
    const r = await call(rpc("initialize", { protocolVersion: 5 }));
    expect(r).toEqual({
      status: 200,
      body: { jsonrpc: "2.0", id: 1, error: { code: -32602, message: "Invalid parameters." } },
    });
  });
});

describe("ping, lists and unknown methods", () => {
  it("answers ping", async () => {
    expect(await call(rpc("ping", undefined, "p"))).toEqual({
      status: 200,
      body: { jsonrpc: "2.0", id: "p", result: {} },
    });
  });

  it("lists the tools offered to this caller, each with a strict schema and the read-only annotations", async () => {
    const r = await call(rpc("tools/list"));
    const listed = (r.body as { result: { tools: Array<Record<string, unknown>> } }).result.tools;
    expect(listed.map((t) => t["name"])).toEqual(["echo", "refuses", "breaks", "huge"]);
    const echo = listed[0]!;
    expect(echo["annotations"]).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    const schema = echo["inputSchema"] as Record<string, unknown>;
    expect(schema["$schema"]).toBeUndefined();
    expect(schema["type"]).toBe("object");
    expect(schema["additionalProperties"]).toBe(false);
    expect(schema["required"]).toEqual(["word"]);
    const narrowed = await call(rpc("tools/list"), { offered: ["echo"] });
    expect((narrowed.body as { result: { tools: unknown[] } }).result.tools).toHaveLength(1);
  });

  it("answers 'method not found' for what it does not speak, without repeating the method", async () => {
    for (const method of [
      "resources/list",
      "prompts/list",
      "logging/setLevel",
      "tools/delete",
      "sampling/createMessage",
    ]) {
      const r = await call(rpc(method));
      expect(r).toEqual({
        status: 200,
        body: { jsonrpc: "2.0", id: 1, error: { code: -32601, message: "Method not found." } },
      });
    }
  });
});

describe("tools/call", () => {
  const callTool = (name: string, args?: unknown, context: Ctx = ctx) =>
    call(rpc("tools/call", { name, arguments: args }), context);

  it("runs a tool and answers text and structure", async () => {
    const r = await callTool("echo", { word: "ab", times: 2 });
    expect(r.body).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: {
        content: [{ type: "text", text: "abab" }],
        structuredContent: { word: "ab", times: 2 },
      },
    });
  });

  it("answers wrong arguments as a tool error the model can act on, naming the field and never the value", async () => {
    for (const args of [
      {},
      { word: 5 },
      { word: SECRET + "x".repeat(30) },
      { word: "a", extra: SECRET },
      { word: "a", times: 9 },
    ]) {
      const r = await callTool("echo", args);
      const result = (r.body as { result: { isError?: boolean; content: Array<{ text: string }> } })
        .result;
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toMatch(/^The arguments are not valid \(/);
      expect(JSON.stringify(r.body)).not.toContain(SECRET);
    }
  });

  it("passes the words of a ToolError and hides everything else a tool throws", async () => {
    const refused = await callTool("refuses", {});
    expect(JSON.stringify(refused.body)).toContain("hidden column: api_token");
    expect((refused.body as { result: { isError: boolean } }).result.isError).toBe(true);
    const broke = await callTool("breaks", {});
    expect(JSON.stringify(broke.body)).not.toContain(SECRET);
    expect(JSON.stringify(broke.body)).toContain("The tool failed.");
  });

  it("refuses an answer that is too large instead of cutting it in the middle", async () => {
    const r = await callTool("huge", {});
    const result = (r.body as { result: { isError: boolean; content: Array<{ text: string }> } })
      .result;
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/too large/);
  });

  it("a tool that is not offered to this caller is a tool nobody made, and a bad call is invalid parameters", async () => {
    const hidden = await callTool("echo", { word: "a" }, { offered: [] });
    expect(hidden.body).toEqual({
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32602, message: "Unknown tool." },
    });
    const nobody = await callTool("nothing", {});
    expect(nobody.body).toEqual(hidden.body);
    const bad = await call(rpc("tools/call", { arguments: {} }));
    expect(bad.body).toEqual({
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32602, message: "Invalid parameters." },
    });
  });
});

describe("what a body is", () => {
  it("accepts a notification with no answer (202)", async () => {
    expect(await call({ jsonrpc: "2.0", method: "notifications/initialized" })).toEqual({
      status: 202,
      body: null,
    });
    expect(
      await call({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 1 } }),
    ).toEqual({ status: 202, body: null });
  });

  it("accepts an answer of the client (this server asks nothing) with no answer", async () => {
    expect(await call({ jsonrpc: "2.0", id: 7, result: {} })).toEqual({ status: 202, body: null });
  });

  it("refuses what is not a request, with 400 and an error that repeats nothing", async () => {
    for (const body of [
      "text",
      5,
      null,
      {},
      { jsonrpc: "1.0", id: 1, method: "ping" },
      { jsonrpc: "2.0", id: {}, method: "ping" },
      { jsonrpc: "2.0", id: 1, method: "" },
      { jsonrpc: "2.0", id: 1, method: "ping", params: "x" },
    ]) {
      const r = await call(body);
      expect(r.status).toBe(400);
      expect(r.body).toMatchObject({
        jsonrpc: "2.0",
        error: { code: -32600, message: "Invalid request." },
      });
    }
  });

  it("answers a batch in order, skips the notifications in it, and refuses an empty or a too long one", async () => {
    const r = await call([
      rpc("ping", undefined, 1),
      { jsonrpc: "2.0", method: "notifications/initialized" },
      rpc("tools/list", undefined, "b"),
      5,
    ]);
    const body = r.body as Array<{ id: unknown; result?: unknown; error?: unknown }>;
    expect(body.map((x) => x.id)).toEqual([1, "b", null]);
    expect(body[2]!.error).toBeDefined();
    expect((await call([])).status).toBe(400);
    expect(
      (await call(Array.from({ length: MAX_BATCH + 1 }, (_, i) => rpc("ping", undefined, i))))
        .status,
    ).toBe(400);
    expect(await call([{ jsonrpc: "2.0", method: "notifications/initialized" }])).toEqual({
      status: 202,
      body: null,
    });
  });

  it("answers every request with its own id", async () => {
    for (const id of [0, 1, 99999, "abc", "a-b_c"]) {
      expect(((await call(rpc("ping", undefined, id))).body as { id: unknown }).id).toBe(id);
    }
  });
});

describe("resources and prompts (when the server has them)", () => {
  const rich = createMcpServer<Ctx>({
    name: "rich",
    title: "Rich",
    version: "1.0.0",
    instructions: "Read only.",
    tools: () => [],
    resources: {
      list: (c) =>
        c.offered.includes("doc")
          ? [
              {
                uri: "test://doc",
                name: "doc",
                title: "A document",
                description: "Text.",
                mimeType: "text/markdown",
              },
              {
                uri: "test://big",
                name: "big",
                title: "Big",
                description: "Too large.",
                mimeType: "text/plain",
              },
              {
                uri: "test://breaks",
                name: "breaks",
                title: "Breaks",
                description: "Fails.",
                mimeType: "text/plain",
              },
            ]
          : [],
      read: async (uri) => {
        if (uri === "test://doc") return "# Hello";
        if (uri === "test://big") return "x".repeat(MAX_RESULT_CHARS + 1);
        if (uri === "test://breaks") throw new Error(`database said: ${SECRET}`);
        return null;
      },
    },
    prompts: () => [
      {
        name: "ask",
        title: "Ask",
        description: "Asks about a thing.",
        arguments: [
          { name: "thing", description: "The thing.", required: true },
          { name: "extra", description: "More.", required: false },
        ],
        text: (args) =>
          `Tell me about ${args["thing"]}${args["extra"] ? ` and ${args["extra"]}` : ""}.`,
      },
    ],
  });
  const rcall = (body: unknown, context: Ctx = ctx) => rich.handle(body, context);
  const result = (r: { body: unknown }) => (r.body as { result: Record<string, unknown> }).result;
  const error = (r: { body: unknown }) =>
    (r.body as { error: { code: number; message: string } }).error;
  const withDoc: Ctx = { offered: ["doc"] };

  it("declares them at initialize, and a server without them declares neither", async () => {
    const caps = result(await rcall(rpc("initialize", { protocolVersion: "2025-06-18" })))[
      "capabilities"
    ];
    expect(caps).toEqual({
      tools: { listChanged: false },
      resources: { subscribe: false, listChanged: false },
      prompts: { listChanged: false },
    });
    const plain = result(await call(rpc("initialize", { protocolVersion: "2025-06-18" })));
    expect(plain["capabilities"]).toEqual({ tools: { listChanged: false } });
  });

  it("lists what the context allows and reads only what is listed", async () => {
    expect(result(await rcall(rpc("resources/list"), ctx))["resources"]).toEqual([]);
    expect(
      (result(await rcall(rpc("resources/list"), withDoc))["resources"] as unknown[]).length,
    ).toBe(3);
    expect(result(await rcall(rpc("resources/read", { uri: "test://doc" }), withDoc))).toEqual({
      contents: [{ uri: "test://doc", mimeType: "text/markdown", text: "# Hello" }],
    });
    // Not listed for this caller: the same answer as a resource nobody made, and the uri is not repeated.
    const none = await rcall(rpc("resources/read", { uri: "test://doc" }), ctx);
    expect(error(none)).toEqual({ code: -32002, message: "Resource not found." });
    expect(
      JSON.stringify(await rcall(rpc("resources/read", { uri: "test://nope-SECRET" }), withDoc)),
    ).not.toContain("SECRET");
    expect(result(await rcall(rpc("resources/templates/list"), withDoc))).toEqual({
      resourceTemplates: [],
    });
  });

  it("refuses a document that is too large and says nothing of an error that holds a value", async () => {
    expect(
      error(await rcall(rpc("resources/read", { uri: "test://big" }), withDoc)).message,
    ).toMatch(/too large/);
    const broken = await rcall(rpc("resources/read", { uri: "test://breaks" }), withDoc);
    expect(JSON.stringify(broken)).not.toContain(SECRET);
    expect(error(broken).message).toBe("The document could not be read.");
  });

  it("gives a prompt its declared arguments only, and refuses a missing one", async () => {
    expect(
      (result(await rcall(rpc("prompts/list")))["prompts"] as Array<{ name: string }>).map(
        (p) => p.name,
      ),
    ).toEqual(["ask"]);
    const got = result(
      await rcall(
        rpc("prompts/get", { name: "ask", arguments: { thing: "orders", other: "ignored" } }),
      ),
    );
    expect(got["messages"]).toEqual([
      { role: "user", content: { type: "text", text: "Tell me about orders." } },
    ]);
    expect(error(await rcall(rpc("prompts/get", { name: "ask", arguments: {} }))).message).toBe(
      "Missing argument: thing.",
    );
    expect(error(await rcall(rpc("prompts/get", { name: "nope" }))).message).toBe(
      "Unknown prompt.",
    );
  });
});
