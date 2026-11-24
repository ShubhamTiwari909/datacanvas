/**
 * The MCP server in the packaged app (1.11.0; docs/mcp-server-plan.md; decision 169), with the OFFICIAL client of the Model
 * Context Protocol: over HTTP with the token of /mcp, and over stdio through the bridge `datacanvas mcp` that a Claude app
 * starts. Nothing is shared until the app shares it, and the two tokens are never interchangeable.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import pg from "pg";
import type { Page } from "@playwright/test";
import { expect, settleForAxe, test, type RunningApp, type TestDb } from "./fixtures";

const axeSource = readFileSync(
  createRequire(import.meta.url).resolve("axe-core/axe.min.js"),
  "utf8",
);

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

  test("the official client lists the tools and the one shared connection, over HTTP", async ({
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
    expect(tools.tools.map((t) => t.name)).toEqual([
      "list_connections",
      "list_schemas",
      "list_tables",
      "describe_table",
      "search_objects",
    ]);
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

  test("the structure tools answer the official client for a shared connection, and a table is described with its keys", async ({
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
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual([
      "list_connections",
      "list_schemas",
      "list_tables",
      "describe_table",
      "search_objects",
    ]);
    const schemas = await client.callTool({ name: "list_schemas", arguments: { connection: id } });
    expect(JSON.stringify(schemas.structuredContent)).toContain('"schema":"public"');
    const tables = await client.callTool({
      name: "list_tables",
      arguments: { connection: id, schema: "public" },
    });
    const names = (tables.structuredContent as { tables: Array<{ name: string }> }).tables.map(
      (t) => t.name,
    );
    expect(names).toEqual(expect.arrayContaining(["users", "orders", "products"]));
    const described = await client.callTool({
      name: "describe_table",
      arguments: { connection: id, schema: "public", table: "orders" },
    });
    const data = described.structuredContent as {
      columns: Array<{ name: string }>;
      constraints: Array<{ kind: string }>;
      references: Array<{ references: string }>;
    };
    expect(data.columns.map((c) => c.name)).toContain("id");
    expect(data.constraints.some((c) => c.kind === "primary_key")).toBe(true);
    expect(data.references.map((r) => r.references)).toContain("public.users");
    // Another connection id, shared or not, gets the same sentence as one that never existed.
    const refusal = await client.callTool({
      name: "list_schemas",
      arguments: { connection: "0".repeat(32) },
    });
    expect(refusal.isError).toBe(true);
    // No row of any table reaches this level: a search is by name.
    const found = await client.callTool({
      name: "search_objects",
      arguments: { connection: id, query: "email" },
    });
    expect(found.isError).toBeFalsy();
    await client.close();
  });
});

test.describe("the data level, against a real database", () => {
  async function admin(database: TestDb, text: string) {
    const c = new pg.Client({
      host: database.host,
      port: database.port,
      user: database.user,
      password: database.password,
      database: database.name,
    });
    await c.connect();
    try {
      await c.query(text);
    } finally {
      await c.end();
    }
  }
  async function openClient(page: Page, app: RunningApp, database: TestDb) {
    await admin(
      database,
      `CREATE TABLE public.claude_notes (id int PRIMARY KEY, title text, api_token text);
       INSERT INTO public.claude_notes VALUES (1, 'first', 'tok-SECRET-1'), (2, 'second', 'tok-SECRET-2');`,
    );
    const id = await connect(page, app, database);
    // The data level needs viewing table data, and the test role is a superuser: the person acknowledges it.
    expect(
      (
        await page.request.put(`${app.origin}/api/connections/${id}/data-access`, {
          data: { enabled: true },
        })
      ).status(),
    ).toBe(200);
    const refused = await page.request.put(`${app.origin}/api/connections/${id}/claude`, {
      data: { level: "data" },
    });
    expect(refused.status()).toBe(409);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe(
      "claude_role_not_acknowledged",
    );
    const ok = await page.request.put(`${app.origin}/api/connections/${id}/claude`, {
      data: { level: "data", acknowledgeRole: true, approval: false },
    });
    expect(ok.status()).toBe(200);
    const { port, token } = mcpFile(app);
    const client = new Client({ name: "e2e-data", version: "1.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      }),
    );
    return { id, client };
  }
  const textOf = (r: unknown) => JSON.stringify((r as { content?: unknown }).content);

  test("reads rows and runs a read-only query, with a hidden column never returned", async ({
    page,
    app,
    database,
  }) => {
    const { id, client } = await openClient(page, app, database);
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(
      expect.arrayContaining(["read_rows", "run_readonly_query", "explain_query"]),
    );
    const query = await client.callTool({
      name: "run_readonly_query",
      arguments: { connection: id, sql: "SELECT id, title FROM claude_notes ORDER BY id" },
    });
    expect(query.structuredContent).toMatchObject({
      rows: [
        ["1", "first"],
        ["2", "second"],
      ],
      truncated: false,
    });
    // `SELECT *` names nothing: the column with a sensitive name comes back as NULL.
    const star = await client.callTool({
      name: "run_readonly_query",
      arguments: { connection: id, sql: "SELECT * FROM claude_notes ORDER BY id" },
    });
    expect(star.structuredContent).toMatchObject({
      hiddenColumns: ["api_token"],
      rows: [
        ["1", "first", null],
        ["2", "second", null],
      ],
    });
    expect(JSON.stringify(star)).not.toContain("SECRET");
    // Naming it is refused before anything runs.
    const named = await client.callTool({
      name: "run_readonly_query",
      arguments: { connection: id, sql: "SELECT api_token FROM claude_notes" },
    });
    expect(named.isError).toBe(true);
    expect(textOf(named)).toMatch(/look sensitive \(api_token\)/);
    // A page of rows: the hidden column is left out and named, whatever is asked.
    const rows = await client.callTool({
      name: "read_rows",
      arguments: { connection: id, schema: "public", table: "claude_notes" },
    });
    expect(rows.structuredContent).toMatchObject({
      rows: [
        ["1", "first", null],
        ["2", "second", null],
      ],
      hiddenColumns: ["api_token"],
    });
    expect(JSON.stringify(rows)).not.toContain("SECRET");
    const filtered = await client.callTool({
      name: "read_rows",
      arguments: {
        connection: id,
        schema: "public",
        table: "claude_notes",
        filters: [{ column: "api_token", op: "eq", value: "tok-SECRET-1" }],
      },
    });
    expect(filtered.isError).toBe(true);
    await client.close();
  });

  test("the data level asks before each call: nothing runs before Approve, Deny and Pause refuse, the list holds no value", async ({
    page,
    app,
    database,
  }) => {
    await admin(
      database,
      `CREATE TABLE public.claude_notes (id int PRIMARY KEY, title text);
       INSERT INTO public.claude_notes VALUES (1, 'first-VALUE'), (2, 'second-VALUE');`,
    );
    const id = await connect(page, app, database);
    expect(
      (
        await page.request.put(`${app.origin}/api/connections/${id}/data-access`, {
          data: { enabled: true },
        })
      ).status(),
    ).toBe(200);
    await page.goto(app.link);
    await page.getByRole("button", { name: "Share with Claude: Claude shop" }).click();
    const dialog = page.getByRole("dialog", { name: "Share Claude shop with Claude" });
    await dialog.getByRole("radio", { name: /Structure and data/ }).check();
    // Rows are sent to Anthropic: nothing starts until the person says they understand, and approval is on.
    await expect(dialog.getByLabel("Ask me before each call")).toBeChecked();
    const start = dialog.getByRole("button", { name: "Start sharing the data" });
    await expect(start).toBeDisabled();
    await dialog.getByLabel(/I understand that rows Claude reads are sent to Anthropic/).check();
    await start.click();
    // The test role is a superuser: a second, plainer step ("Share anyway") is needed.
    await expect(dialog.getByRole("alert")).toContainText(/read-only database user/);
    await dialog.getByRole("button", { name: "Share anyway" }).click();
    await expect(dialog.getByRole("button", { name: "Stop sharing" })).toBeVisible();
    await dialog.getByRole("button", { name: "Close", exact: true }).first().click();

    const { port, token } = mcpFile(app);
    const client = new Client({ name: "e2e-approval", version: "1.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      }),
    );
    const ask = (sql: string) =>
      client.callTool({ name: "run_readonly_query", arguments: { connection: id, sql } });
    const settled = (promise: Promise<unknown>) =>
      Promise.race([
        promise.then(() => true),
        new Promise<boolean>((r) => setTimeout(() => r(false), 2500)),
      ]);

    // 1. The call waits: the person is shown what Claude asked, and nothing has run.
    const first = ask("SELECT id, title FROM claude_notes ORDER BY id");
    const prompt = page.getByRole("dialog", { name: /Claude wants to read Claude shop/ });
    await expect(prompt).toBeVisible();
    await expect(prompt.getByLabel("What Claude asked")).toContainText(
      "SELECT id, title FROM claude_notes",
    );
    expect(await settled(first)).toBe(false);
    await settleForAxe(page);
    await page.addScriptTag({ content: axeSource });
    const found = await page.evaluate(async () => {
      const axe = (
        window as unknown as {
          axe: {
            run: (c: Element, o: object) => Promise<{ violations: Array<{ id: string }> }>;
          };
        }
      ).axe;
      const result = await axe.run(document.querySelector('[role="dialog"]') ?? document.body, {
        runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] },
      });
      return result.violations.map((v) => v.id);
    });
    expect(found, "axe on the approval prompt").toEqual([]);
    // Escape does not answer it.
    await page.keyboard.press("Escape");
    await expect(prompt).toBeVisible();
    await prompt.getByRole("button", { name: "Approve" }).click();
    expect((await first).structuredContent).toMatchObject({
      rows: [
        ["1", "first-VALUE"],
        ["2", "second-VALUE"],
      ],
    });
    await expect(prompt).toHaveCount(0);

    // 2. Deny: it never runs, and Claude is told in words.
    const second = ask("SELECT count(*) FROM claude_notes");
    await prompt.getByRole("button", { name: "Deny" }).click();
    const denied = await second;
    expect(denied.isError).toBe(true);
    expect(textOf(denied)).toMatch(/did not approve/);

    // 3. Pause: the next call is refused at once, with no prompt; Resume lets calls through to the prompt again.
    await page.getByRole("button", { name: "Pause Claude" }).click();
    await expect(page.getByRole("button", { name: "Resume Claude" })).toBeVisible();
    const paused = await ask("SELECT 1");
    expect(paused.isError).toBe(true);
    expect(textOf(paused)).toMatch(/paused/);
    await expect(prompt).toHaveCount(0);
    await page.getByRole("button", { name: "Resume Claude" }).click();
    await expect(page.getByRole("button", { name: "Pause Claude" })).toBeVisible();

    // 4. The list says what was asked and how it ended, and holds no value that came back.
    await page.getByRole("button", { name: /^Shared with Claude: Claude shop/ }).click();
    const list = page.getByRole("dialog", { name: "Share Claude shop with Claude" });
    await expect(list).toContainText("What Claude asked");
    await expect(list).toContainText("SELECT id, title FROM claude_notes");
    await expect(list).toContainText("answered, 2 rows");
    await expect(list).toContainText("not approved");
    await expect(list).not.toContainText("VALUE");
    const raw = await page.request.get(`${app.origin}/api/claude/activity`);
    expect(JSON.stringify(await raw.json())).not.toContain("VALUE");
    // The routes behind the cookie are not open to a program with the token of /mcp.
    const bare = await fetch(`${app.origin}/api/claude/activity`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(bare.status).toBeGreaterThanOrEqual(400);
    await client.close();
  });

  test("on a phone the share dialog and the approval prompt fit the screen, and pass axe", async ({
    page,
    app,
    database,
  }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    const id = await connect(page, app, database);
    await page.request.put(`${app.origin}/api/connections/${id}/data-access`, {
      data: { enabled: true },
    });
    await page.goto(app.link);
    await page.getByRole("button", { name: "Open connections and tables" }).click();
    await page.getByRole("button", { name: "Share with Claude: Claude shop" }).click();
    const dialog = page.getByRole("dialog", { name: "Share Claude shop with Claude" });
    await dialog.getByRole("radio", { name: /Structure and data/ }).check();
    // Nothing sticks out of the screen, and every control sits inside the dialog's box.
    const insideTheScreen = async (scope: ReturnType<Page["locator"]>) => {
      await settleForAxe(page);
      const problems = await scope.evaluate((root) => {
        const box = root.getBoundingClientRect();
        const bad: string[] = [];
        if (document.documentElement.scrollWidth > window.innerWidth)
          bad.push("the page scrolls sideways");
        for (const el of root.querySelectorAll("button, input, label, pre, p, h2, [role=note]")) {
          const r = el.getBoundingClientRect();
          if (r.width === 0) continue;
          if (r.left < box.left - 1 || r.right > box.right + 1)
            bad.push(`${el.tagName} ${(el.textContent ?? "").slice(0, 30)} sticks out`);
        }
        return bad;
      });
      expect(problems).toEqual([]);
    };
    await insideTheScreen(dialog);
    await dialog.getByLabel(/I understand that rows Claude reads/).check();
    await dialog.getByRole("button", { name: "Start sharing the data" }).click();
    await dialog.getByRole("button", { name: "Share anyway" }).click();
    await expect(dialog.getByRole("button", { name: "Stop sharing" })).toBeVisible();
    await dialog.getByRole("button", { name: "Close", exact: true }).first().click();
    const { port, token } = mcpFile(app);
    const client = new Client({ name: "e2e-phone", version: "1.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      }),
    );
    const waiting = client.callTool({
      name: "run_readonly_query",
      arguments: { connection: id, sql: `SELECT ${"a_very_long_column_name_".repeat(12)}1` },
    });
    const prompt = page.getByRole("dialog", { name: /Claude wants to read/ });
    await expect(prompt).toBeVisible();
    await insideTheScreen(prompt);
    await settleForAxe(page);
    await page.addScriptTag({ content: axeSource });
    const found = await page.evaluate(async () => {
      const axe = (
        window as unknown as {
          axe: { run: (c: Element, o: object) => Promise<{ violations: Array<{ id: string }> }> };
        }
      ).axe;
      const result = await axe.run(document.querySelector('[role="dialog"]') ?? document.body, {
        runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] },
      });
      return result.violations.map((v) => v.id);
    });
    expect(found, "axe on the approval prompt on a phone").toEqual([]);
    await prompt.getByRole("button", { name: "Deny" }).click();
    expect((await waiting).isError).toBe(true);
    await client.close();
  });

  test("twenty questions about the shop: each can be answered by the tools, in the sequence a model would use", async ({
    page,
    app,
    database,
  }) => {
    const { id, client } = await openClient(page, app, database);
    type Result = { isError?: boolean; structuredContent?: unknown; content?: unknown };
    const rowsOf = (r: Result) => (r.structuredContent as { rows: string[][] }).rows;
    const asString = (r: Result) => JSON.stringify(r.structuredContent ?? r.content);
    const sql = (text: string) => ({
      tool: "run_readonly_query",
      args: { connection: id, sql: text },
    });
    const describe = (table: string) => ({
      tool: "describe_table",
      args: { connection: id, schema: "public", table },
    });
    const questions: Array<{
      ask: string;
      tool: string;
      args: Record<string, unknown>;
      check: (r: Result) => void;
    }> = [
      {
        ask: "Which databases can you see?",
        tool: "list_connections",
        args: {},
        check: (r) => expect(asString(r)).toContain(id),
      },
      {
        ask: "What schemas are there?",
        tool: "list_schemas",
        args: { connection: id },
        check: (r) => expect(asString(r)).toContain('"schema":"public"'),
      },
      {
        ask: "What tables are in public?",
        tool: "list_tables",
        args: { connection: id, schema: "public" },
        check: (r) => expect(asString(r)).toContain('"name":"users"'),
      },
      {
        ask: "Is there anything about e-mail?",
        tool: "search_objects",
        args: { connection: id, query: "email" },
        check: (r) => expect(asString(r)).toContain("email"),
      },
      {
        ask: "What columns does users have?",
        ...describe("users"),
        check: (r) => expect(asString(r)).toContain("email"),
      },
      {
        ask: "What does orders point to?",
        ...describe("orders"),
        check: (r) => expect(asString(r)).toContain("public.users"),
      },
      {
        ask: "What points at users?",
        ...describe("users"),
        check: (r) => expect(asString(r)).toContain("public.orders"),
      },
      {
        ask: "What is the key of order_items?",
        ...describe("order_items"),
        check: (r) => expect(asString(r)).toContain("primary_key"),
      },
      {
        ask: "What indexes does orders have, and how big is it?",
        ...describe("orders"),
        check: (r) => expect(asString(r)).toMatch(/indexes/),
      },
      {
        ask: "How many users are there?",
        ...sql("SELECT count(*) FROM public.users"),
        check: (r) => expect(Number(rowsOf(r)[0]![0])).toBeGreaterThanOrEqual(0),
      },
      {
        ask: "Show me a few users.",
        tool: "read_rows",
        args: { connection: id, schema: "public", table: "users", page_size: 3 },
        check: (r) => {
          expect(r.isError).toBeFalsy();
          expect(rowsOf(r).length).toBeLessThanOrEqual(3);
        },
      },
      {
        ask: "The three newest orders?",
        ...sql("SELECT id, placed_at FROM public.orders ORDER BY id DESC LIMIT 3"),
        check: (r) => expect(r.isError).toBeFalsy(),
      },
      {
        ask: "Orders per status?",
        ...sql("SELECT status, count(*) FROM public.orders GROUP BY status ORDER BY 2 DESC"),
        check: (r) => expect(r.isError).toBeFalsy(),
      },
      {
        ask: "Which users have orders?",
        ...sql(
          "SELECT u.id, count(o.id) FROM public.users u JOIN public.orders o ON o.user_id = u.id GROUP BY u.id LIMIT 10",
        ),
        check: (r) => expect(r.isError).toBeFalsy(),
      },
      {
        ask: "Which tables have no primary key?",
        ...sql(
          "SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conrelid = c.oid AND k.contype = 'p')",
        ),
        check: (r) => expect(r.isError).toBeFalsy(),
      },
      {
        ask: "Which is the biggest table?",
        ...sql(
          "SELECT relname, pg_total_relation_size(oid) FROM pg_class WHERE relkind = 'r' AND relnamespace = 'public'::regnamespace ORDER BY 2 DESC LIMIT 1",
        ),
        check: (r) => expect(rowsOf(r)).toHaveLength(1),
      },
      {
        ask: "How would you run the orders-by-user query?",
        tool: "explain_query",
        args: { connection: id, sql: "SELECT * FROM public.orders WHERE user_id = 1" },
        check: (r) => expect((r.structuredContent as { plan: unknown }).plan).not.toBeNull(),
      },
      {
        ask: "Which columns of products can be NULL?",
        ...sql(
          "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'products' AND is_nullable = 'YES'",
        ),
        check: (r) => expect(r.isError).toBeFalsy(),
      },
      {
        ask: "Show me the tokens in claude_notes.",
        ...sql("SELECT api_token FROM public.claude_notes"),
        check: (r) => {
          // Refused before it runs, in words that say why and what to do: never a value.
          expect(r.isError).toBe(true);
          expect(asString(r)).toMatch(/look sensitive/);
          expect(asString(r)).not.toContain("SECRET");
        },
      },
      {
        ask: "Then read the notes table.",
        tool: "read_rows",
        args: { connection: id, schema: "public", table: "claude_notes" },
        check: (r) => {
          expect(asString(r)).toContain("api_token");
          expect(asString(r)).not.toContain("SECRET");
        },
      },
    ];
    expect(questions).toHaveLength(20);
    const offered = new Map((await client.listTools()).tools.map((t) => [t.name, t]));
    // What a model is told before it asks: the server's instructions say to describe a table before querying it.
    expect(client.getInstructions()).toMatch(/describe_table/);
    for (const tool of offered.values())
      expect((tool.description ?? "").length).toBeGreaterThan(60);
    for (const q of questions) {
      expect(offered.has(q.tool), `${q.ask}: the tool is offered`).toBe(true);
      const result = (await client.callTool({ name: q.tool, arguments: q.args })) as Result;
      try {
        q.check(result);
      } catch (error) {
        throw new Error(
          `"${q.ask}" through ${q.tool} was not answered as expected: ${String(error)}`,
        );
      }
    }
  });

  test("what the independent review found: hidden names cannot be smuggled, a cursor holds no key, Pause cancels what runs, no value in an error", async ({
    page,
    app,
    database,
  }) => {
    await admin(
      database,
      `CREATE TABLE public.rv_acct (id int PRIMARY KEY, password_hash text, note text);
       INSERT INTO public.rv_acct VALUES (1, 'S3CRETHASH-aaa', 'hello'), (2, 'S3CRETHASH-bbb', 'bye');
       CREATE TABLE public.rv_keyed (api_token text PRIMARY KEY DEFAULT 'DEFAULT-SECRET-VALUE', label text);
       INSERT INTO public.rv_keyed VALUES ('TOKEN-ABC-123', 'a'), ('TOKEN-DEF-456', 'b');
       ANALYZE public.rv_acct;`,
    );
    const { id, client } = await openClient(page, app, database);
    const run = (sql: string) =>
      client.callTool({ name: "run_readonly_query", arguments: { connection: id, sql } });
    const all = (r: unknown) => JSON.stringify(r);
    // A comment opener inside a string does not hide the column that follows.
    for (const sql of [
      "select '/*', password_hash as x, '*/' from rv_acct",
      "select '--', password_hash as x from rv_acct",
      // The statistics catalogs hold sampled values of every column.
      "select most_common_vals::text from pg_stats where tablename = 'rv_acct'",
      "select * from pg_catalog.pg_statistic limit 1",
      // Effects outside the data.
      "select pg_notify('zz','x')",
      "select pg_advisory_lock(42)",
    ]) {
      const r = await run(sql);
      expect(r.isError, sql).toBe(true);
      expect(all(r), sql).not.toContain("S3CRETHASH");
    }
    // The text of an error never carries a row: the cast of a whole row to a name is not passed on.
    const cast = await run("select (t::text)::regclass from rv_acct t");
    expect(cast.isError).toBe(true);
    expect(all(cast)).not.toContain("S3CRETHASH");
    expect(all(cast)).not.toContain("hello");
    // A page whose KEY is hidden: the cursor Claude gets holds no key, and one it makes up is refused.
    const first = (await client.callTool({
      name: "read_rows",
      arguments: { connection: id, schema: "public", table: "rv_keyed", page_size: 1 },
    })) as unknown as { structuredContent: { nextCursor: string | null; rows: unknown[][] } };
    const cursor = first.structuredContent.nextCursor;
    expect(cursor).not.toBeNull();
    expect(Buffer.from(cursor!, "base64url").toString("latin1")).not.toContain("TOKEN");
    expect(all(first)).not.toContain("TOKEN-ABC");
    const forged = Buffer.from(JSON.stringify({ k: ["TOKEN-D"] })).toString("base64url");
    const refused = await client.callTool({
      name: "read_rows",
      arguments: { connection: id, schema: "public", table: "rv_keyed", cursor: forged },
    });
    expect(refused.isError).toBe(true);
    const second = (await client.callTool({
      name: "read_rows",
      arguments: {
        connection: id,
        schema: "public",
        table: "rv_keyed",
        page_size: 1,
        cursor: cursor!,
      },
    })) as unknown as { isError?: boolean; structuredContent: { rows: unknown[][] } };
    expect(second.isError).toBeFalsy();
    expect(second.structuredContent.rows).toHaveLength(1);
    // The default and the check of a hidden column are not described.
    const described = await client.callTool({
      name: "describe_table",
      arguments: { connection: id, schema: "public", table: "rv_keyed" },
    });
    expect(all(described)).not.toContain("DEFAULT-SECRET-VALUE");
    // Pause cancels what is running, and nothing it read is handed over.
    const slow = run("select pg_sleep(6), 'delivered-after-pause' as msg");
    await new Promise((r) => setTimeout(r, 700));
    const started = Date.now();
    await page.request.put(`${app.origin}/api/claude/pause`, { data: { paused: true } });
    const done = await slow;
    expect(Date.now() - started).toBeLessThan(4000);
    expect(done.isError).toBe(true);
    expect(all(done)).not.toContain("delivered-after-pause");
    await client.close();
  });

  test("refuses what a read-only transaction refuses, two statements, and a query that would run past its time", async ({
    page,
    app,
    database,
  }) => {
    const { id, client } = await openClient(page, app, database);
    const run = (sql: string, extra: Record<string, unknown> = {}) =>
      client.callTool({ name: "run_readonly_query", arguments: { connection: id, sql, ...extra } });
    for (const sql of [
      "DELETE FROM claude_notes",
      "CREATE TABLE evil (a int)",
      "SELECT 1; SELECT 2",
      "INSERT INTO claude_notes VALUES (9, 'x', 'y')",
      "EXPLAIN ANALYZE CREATE TABLE evil2 AS SELECT 1",
      "SELECT pg_sleep(0)\n; DROP TABLE claude_notes",
    ]) {
      const r = await run(sql);
      expect(r.isError, sql).toBe(true);
    }
    // Nothing was changed.
    const count = await run("SELECT count(*) AS n FROM claude_notes");
    expect(count.structuredContent).toMatchObject({ rows: [["2"]] });
    // A query that runs past its time limit is stopped, and says so.
    const slow = await run("SELECT pg_sleep(5)", { timeout_seconds: 1 });
    expect(slow.isError).toBe(true);
    expect(textOf(slow)).toMatch(/timeout|time/i);
    // The database's message about a value is not passed on: casting a text to a number names the text in the message.
    const cast = await run("SELECT CAST(title AS int) FROM claude_notes");
    expect(cast.isError).toBe(true);
    expect(textOf(cast)).not.toContain("first");
    await client.close();
  });

  test("explains a query without running it", async ({ page, app, database }) => {
    const { id, client } = await openClient(page, app, database);
    const plan = await client.callTool({
      name: "explain_query",
      arguments: { connection: id, sql: "SELECT * FROM claude_notes WHERE id = 1" },
    });
    expect(JSON.stringify(plan.structuredContent)).toMatch(/Node Type/);
    await client.close();
  });
});

test.describe("Share with Claude, in the app", () => {
  async function connectInApp(page: Page, app: RunningApp, database: TestDb) {
    await page.goto(app.link);
    await page.getByRole("button", { name: "Connect PostgreSQL" }).click();
    await page.getByLabel("Connection name").fill("UI shop");
    await page.getByRole("tab", { name: /connection string/i }).click();
    await page.getByRole("textbox", { name: "Connection string" }).fill(database.url);
    await page.getByRole("button", { name: /^Connect$/ }).click();
    await expect(page.getByRole("button", { name: "Disconnect UI shop" })).toBeVisible();
  }

  test("says what leaves the machine before anything is shared, shares the structure, and stops", async ({
    page,
    app,
    database,
  }) => {
    await connectInApp(page, app, database);
    await page.getByRole("button", { name: "Share with Claude: UI shop" }).click();
    const dialog = page.getByRole("dialog", { name: "Share UI shop with Claude" });
    await expect(dialog).toContainText("sent to Anthropic by the Claude app you use");
    await expect(dialog).toContainText("cannot stop that or take it back");
    await expect(dialog).toContainText("never saved");
    await expect(dialog.getByLabel("Command for Claude Code", { exact: true })).toContainText(
      "claude mcp add datacanvas -- npx --yes @shubhamtiwari909/datacanvas mcp",
    );
    await expect(dialog.getByLabel("Config for Claude Desktop", { exact: true })).toContainText(
      '"command": "npx"',
    );
    // Nothing is shared yet.
    const { port, token } = mcpFile(app);
    const ping = () =>
      fetch(`http://127.0.0.1:${port}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
      });
    expect((await ping()).status).toBe(404);
    await dialog.getByRole("button", { name: "Start sharing the structure" }).click();
    await expect(dialog.getByRole("button", { name: "Stop sharing" })).toBeVisible();
    expect((await ping()).status).toBe(200);
    await dialog.getByRole("button", { name: "Close", exact: true }).first().click();
    await expect(page.getByText("structure", { exact: true }).first()).toBeVisible();
    // Stop it again from the dialog.
    await page.getByRole("button", { name: /^Shared with Claude: UI shop/ }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Stop sharing" }).click();
    await expect(page.getByRole("button", { name: "Share with Claude: UI shop" })).toBeVisible();
    expect((await ping()).status).toBe(404);
  });

  test("passes axe in light and in dark", async ({ page, app, database }) => {
    await connectInApp(page, app, database);
    await page.getByRole("button", { name: "Share with Claude: UI shop" }).click();
    await expect(page.getByRole("dialog", { name: "Share UI shop with Claude" })).toBeVisible();
    const check = async (name: string) => {
      await settleForAxe(page);
      await page.addScriptTag({ content: axeSource });
      const found = await page.evaluate(async () => {
        const axe = (
          window as unknown as {
            axe: {
              run: (
                c: Element,
                o: object,
              ) => Promise<{ violations: Array<{ id: string; impact: string | null }> }>;
            };
          }
        ).axe;
        const result = await axe.run(document.querySelector('[role="dialog"]') ?? document.body, {
          runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] },
        });
        return result.violations.map((v) => `${v.id} (${v.impact})`);
      });
      expect.soft(found, `axe on Share with Claude (${name})`).toEqual([]);
    };
    await check("light");
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: /^Theme:/ }).click();
    await page.getByRole("menuitemradio", { name: "Dark" }).click();
    await expect(page.getByRole("menu")).toHaveCount(0);
    await page.getByRole("button", { name: "Share with Claude: UI shop" }).click();
    await expect(page.getByRole("dialog", { name: "Share UI shop with Claude" })).toBeVisible();
    await check("dark");
  });
});
