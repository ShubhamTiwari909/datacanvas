/**
 * Install and failure QA: what a user sees when things go wrong.
 *  - wrong password, unreachable database, TLS asked of a server without TLS
 *  - port already taken
 * Each must give a clear, safe message and leave DataCanvas usable.
 */
import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

const cli = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.package/bin/datacanvas.mjs",
);

test("a wrong password is reported without echoing it", async ({ page, app, database }) => {
  await page.goto(app.link);
  await page.getByRole("button", { name: "Connect PostgreSQL" }).click();
  await page.getByLabel("Connection name").fill("Wrong password");
  await page.getByRole("tab", { name: /connection string/i }).click();
  const bad = database.url.replace(`:${database.password}@`, ":definitely-wrong-pw@");
  await page.getByRole("textbox", { name: "Connection string" }).fill(bad);
  await page.getByRole("button", { name: /^Connect$/ }).click();
  const alert = page.getByRole("alert").first();
  await expect(alert).toBeVisible();
  await expect(alert).not.toContainText("definitely-wrong-pw");
  await expect(page.getByRole("button", { name: "Disconnect Wrong password" })).toHaveCount(0);
});

test.describe("errors through the API", () => {
  async function tryConnect(
    page: Page,
    app: { link: string; origin: string },
    body: Record<string, unknown>,
  ) {
    await page.goto(app.link);
    const response = await page.request.post(`${app.origin}/api/connections/test`, {
      headers: { origin: app.origin },
      data: { mode: "fields", name: "x", ...body },
    });
    return { status: response.status(), body: await response.json() };
  }

  test("unreachable database", async ({ page, app, database }) => {
    const result = await tryConnect(page, app, {
      host: "127.0.0.1",
      port: 1,
      database: "postgres",
      username: database.user,
      password: database.password,
      sslMode: "disable",
    });
    expect(result.body.error.code).toBe("unreachable");
    expect(JSON.stringify(result.body)).not.toContain(database.password);
  });

  test("TLS required but the server has none", async ({ page, app, database }) => {
    const result = await tryConnect(page, app, {
      host: database.host,
      port: database.port,
      database: database.name,
      username: database.user,
      password: database.password,
      sslMode: "verify-full",
    });
    expect(result.status).toBeGreaterThanOrEqual(400);
    expect(["ssl_error", "unreachable"]).toContain(result.body.error.code);
    expect(JSON.stringify(result.body)).not.toContain(database.password);
  });

  test("wrong password gives authentication_failed", async ({ page, app, database }) => {
    const result = await tryConnect(page, app, {
      host: database.host,
      port: database.port,
      database: database.name,
      username: database.user,
      password: "nope-nope",
      sslMode: "disable",
    });
    expect(result.body.error.code).toBe("authentication_failed");
  });
});

test("a taken --port stops with a clear message instead of starting", async () => {
  const blocker = net.createServer();
  await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
  const { port } = blocker.address() as net.AddressInfo;
  try {
    // A private data folder: a test must never create files in the real ~/.datacanvas.
    const home = await mkdtemp(path.join(os.tmpdir(), "dc-e2e-port-"));
    const child = spawn(process.execPath, [cli, "--no-open", "--port", String(port)], {
      env: { ...process.env, DATACANVAS_HOME: home },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (d) => (output += d));
    child.stderr.on("data", (d) => (output += d));
    const code = await new Promise<number | null>((resolve) => child.once("exit", resolve));
    expect(code).toBe(1);
    expect(output).toContain("already in use");
  } finally {
    blocker.close();
  }
});

test.describe("connection strings written the libpq / Cloud SQL way", () => {
  async function openStringForm(
    page: Page,
    app: { link: string },
    name: string,
    connectionString: string,
  ) {
    await page.goto(app.link);
    await page.getByRole("button", { name: "Connect PostgreSQL" }).click();
    await page.getByLabel("Connection name").fill(name);
    await page.getByRole("tab", { name: /connection string/i }).click();
    await page.getByRole("textbox", { name: "Connection string" }).fill(connectionString);
    await page.getByRole("button", { name: /^Connect$/ }).click();
  }

  test("a Cloud SQL socket string is explained, without repeating the secret", async ({
    page,
    app,
  }) => {
    const secret = "hunter2-not-a-real-password";
    await openStringForm(
      page,
      app,
      "Socket",
      `postgresql://app_user:${secret}@/appdb?host=/cloudsql/my-project:us-central1:my-instance&schema=public`,
    );
    const text = page.locator("body");
    await expect(text).toContainText("Unix socket");
    await expect(text).toContainText("Cloud SQL Auth Proxy");
    await expect(text).not.toContainText(secret);
    await expect(text).not.toContainText("URL-encoded");
    await expect(page.getByRole("button", { name: "Disconnect Socket" })).toHaveCount(0);
  });

  test("a string with the host in ?host= connects to a real database", async ({
    page,
    app,
    database,
  }) => {
    await openStringForm(
      page,
      app,
      "Query host",
      `postgresql://${database.user}:${database.password}@/${database.name}?host=${database.host}&port=${database.port}&sslmode=disable`,
    );
    await expect(page.getByRole("button", { name: "Disconnect Query host" })).toBeVisible();
  });
});
