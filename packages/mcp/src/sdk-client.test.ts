/**
 * The server against the OFFICIAL SDK's client, over real HTTP: the proof that what this small server speaks is what
 * the clients of the Model Context Protocol expect (`docs/mcp-server-plan.md`, section 11). The HTTP part is test code only:
 * the package itself has no network code.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMcpServer } from "./protocol.js";
import { READ_ONLY, ToolError, type ToolDefinition } from "./tools.js";

const tools: Array<ToolDefinition<null>> = [
  {
    name: "add",
    title: "Add",
    description: "Adds two whole numbers.",
    input: z.strictObject({ a: z.number().int(), b: z.number().int() }),
    annotations: READ_ONLY,
    run: async (args) => {
      const { a, b } = args as { a: number; b: number };
      return { text: `${a + b}`, data: { sum: a + b } };
    },
  },
  {
    name: "refuse",
    title: "Refuse",
    description: "Refuses with words.",
    input: z.strictObject({}),
    annotations: READ_ONLY,
    run: async () => {
      throw new ToolError("Not shared with Claude.");
    },
  },
];
const mcp = createMcpServer<null>({
  name: "dc-test",
  title: "DC test",
  version: "9.9.9",
  instructions: "Read only.",
  tools: () => tools,
});

let http: Server;
let url: URL;
const seen: Array<{ method: string; version: string | undefined }> = [];

beforeAll(async () => {
  http = createServer((request, response) => {
    if (request.method !== "POST") {
      response.writeHead(405, { Allow: "POST" }).end();
      return;
    }
    let text = "";
    request.on("data", (chunk) => (text += chunk));
    request.on("end", () => {
      void (async () => {
        let body: unknown;
        try {
          body = JSON.parse(text);
        } catch {
          response.writeHead(400).end();
          return;
        }
        const version = request.headers["mcp-protocol-version"];
        seen.push({
          method: String((body as { method?: unknown }).method),
          version: typeof version === "string" ? version : undefined,
        });
        const result = await mcp.handle(body, null);
        if (result.body === null) {
          response.writeHead(result.status).end();
          return;
        }
        response
          .writeHead(result.status, { "Content-Type": "application/json" })
          .end(JSON.stringify(result.body));
      })();
    });
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  url = new URL(`http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`);
});
afterAll(async () => {
  await new Promise<void>((resolve) => http.close(() => resolve()));
});

describe("the official client of the Model Context Protocol", () => {
  it("connects, negotiates a version, lists the tools and calls them", async () => {
    const client = new Client({ name: "sdk-test", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(url));
    expect(client.getServerVersion()).toMatchObject({ name: "dc-test", version: "9.9.9" });
    expect(client.getInstructions()).toBe("Read only.");
    const listed = await client.listTools();
    expect(listed.tools.map((t) => t.name)).toEqual(["add", "refuse"]);
    expect(listed.tools[0]!.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
    });

    const added = await client.callTool({ name: "add", arguments: { a: 2, b: 40 } });
    expect(added.structuredContent).toEqual({ sum: 42 });
    expect(added.content).toEqual([{ type: "text", text: "42" }]);

    const wrong = await client.callTool({ name: "add", arguments: { a: "x" } });
    expect(wrong.isError).toBe(true);
    const refused = await client.callTool({ name: "refuse", arguments: {} });
    expect(refused).toMatchObject({
      isError: true,
      content: [{ type: "text", text: "Not shared with Claude." }],
    });
    await client.ping();
    await client.close();
    // The client says which version it speaks on every request after the first.
    expect(seen.some((s) => s.method === "tools/list" && s.version !== undefined)).toBe(true);
  });

  it("gets an error, not a hang, for a method the server does not speak", async () => {
    const client = new Client({ name: "sdk-test", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(url));
    await expect(client.listResources()).rejects.toThrow();
    await client.close();
  });
});
