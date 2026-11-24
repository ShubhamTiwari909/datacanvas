/**
 * The MCP server in the packaged app (1.11.0; docs/mcp-server-plan.md; decision 169), with the OFFICIAL client of the Model
 * Context Protocol: over HTTP with the token of /mcp, and over stdio through the bridge `datacanvas mcp` that a Claude app
 * starts. Nothing is shared until the app shares it, and the two tokens are never interchangeable.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Page } from "@playwright/test";
import { expect, test, type RunningApp, type TestDb } from "./fixtures";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, ".package/bin/datacanvas.mjs");

const mcpFile = (app: RunningApp): { pid: number; port: number; token: string } =>
  JSON.parse(readFileSync(path.join(app.home, "mcp.json"), "utf8"));

/** Connect through the app's own API (the browser's cookie is the credential), and return the connection's id. */
async function connect(page: Page, app: RunningApp, database: TestDb): Promise<string> {
  await page.goto(app.link);
  const response = await page.request.post(`${app.origin}/api/connections`, {
    data: {
      mode: "fields",
      name: "Claude shop",
      host: database.host,
      port: database.port,
      database: database.name,
      username: database.user,
      password: database.password,
      sslMode: "disable",
    },
  });
  expect(response.status()).toBe(201);
  return ((await response.json()) as { connection: { id: string } }).connection.id;
}

const share = (page: Page, app: RunningApp, id: string, level: string) =>
  page.request.put(`${app.origin}/api/connections/${id}/claude`, { data: { level } });

test.describe("the MCP server", () => {
  test("does not exist until a connection is shared, and then answers only the program with its own token", async ({
    page,
    app,
    database,
  }) => {
    const id = await connect(page, app, database);
    const { port, token } = mcpFile(app);
    const ping = (headers: Record<string, string>) =>
      fetch(`http://127.0.0.1:${port}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
      });
    // Nothing shared: not found, even with the right token.
    expect((await ping({ Authorization: `Bearer ${token}` })).status).toBe(404);
    expect((await share(page, app, id, "structure")).status()).toBe(200);
    expect((await ping({ Authorization: `Bearer ${token}` })).status).toBe(200);
    // Without the token, with a wrong one, and from a browser (an Origin header): refused.
    expect((await ping({})).status).toBe(401);
    expect((await ping({ Authorization: `Bearer ${"x".repeat(43)}` })).status).toBe(401);
    expect(
      (await ping({ Authorization: `Bearer ${token}`, Origin: `http://127.0.0.1:${port}` })).status,
    ).toBe(403);
    // The token of /mcp is not a credential for the app: the same bearer on an API route is refused.
    const api = await fetch(`http://127.0.0.1:${port}/api/connections`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(api.status).toBe(401);
    // And the cookie of the browser does not open /mcp.
    const cookies = await page.context().cookies();
    const cookie = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    expect((await ping({ Cookie: cookie })).status).toBe(401);
    // Stopping the sharing makes it not exist again.
    await share(page, app, id, "off");
    expect((await ping({ Authorization: `Bearer ${token}` })).status).toBe(404);
  });

  test("the official client lists the shared connection and nothing else, over HTTP", async ({
    page,
    app,
    database,
  }) => {
    const id = await connect(page, app, database);
    await share(page, app, id, "structure");
    const { port, token } = mcpFile(app);
    const client = new Client({ name: "e2e", version: "1.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      }),
    );
    expect(client.getServerVersion()).toMatchObject({ name: "datacanvas" });
    expect(client.getInstructions()).toMatch(/READ-ONLY/);
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).toEqual(["list_connections"]);
    const called = await client.callTool({ name: "list_connections", arguments: {} });
    expect(called.isError).toBeFalsy();
    const connections = (called.structuredContent as { connections: Array<Record<string, string>> })
      .connections;
    expect(connections).toEqual([
      { id, name: "Claude shop", database: database.name, level: "structure" },
    ]);
    await client.close();
  });

  test("the bridge a Claude app starts reaches the running app over stdio, and says so in words when it is not running", async ({
    page,
    app,
    database,
  }) => {
    const id = await connect(page, app, database);
    await share(page, app, id, "structure");
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [cli, "mcp"],
      env: { ...(process.env as Record<string, string>), DATACANVAS_HOME: app.home },
      stderr: "pipe",
    });
    const client = new Client({ name: "e2e-stdio", version: "1.0.0" });
    await client.connect(transport);
    const called = await client.callTool({ name: "list_connections", arguments: {} });
    expect(JSON.stringify(called.structuredContent)).toContain(id);
    await client.close();

    // A bridge with no running DataCanvas (an empty data folder) answers in plain words, with nothing else on stdout.
    const lonely = new StdioClientTransport({
      command: process.execPath,
      args: [cli, "mcp"],
      env: {
        ...(process.env as Record<string, string>),
        DATACANVAS_HOME: path.join(app.home, "nowhere"),
      },
      stderr: "pipe",
    });
    const orphan = new Client({ name: "e2e-lonely", version: "1.0.0" });
    await expect(orphan.connect(lonely)).rejects.toThrow(/Start DataCanvas/);
    await orphan.close().catch(() => {});
  });
});
