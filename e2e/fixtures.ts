/**
 * Test fixtures: a real DataCanvas process and a real PostgreSQL database.
 *
 * `app` starts the packaged CLI exactly as a user would (no browser opened),
 * with a private data folder, and hands the test the private link. `database`
 * creates a uniquely named database with the sample shop and drops it again.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createTestDatabase, testDatabaseUrl } from "@datacanvas/postgres-adapter/testing";
import { test as base, expect } from "@playwright/test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, ".package/bin/datacanvas.mjs");

export interface RunningApp {
  /** The private first-visit link, including the session token. */
  link: string;
  origin: string;
  port: number;
  home: string;
  /** Everything the process printed so far. */
  output: () => string;
  /** Stop with Ctrl+C semantics and wait for the exit code. */
  stop: () => Promise<number | null>;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

export async function startApp(home?: string, extraArgs: string[] = []): Promise<RunningApp> {
  const dataHome = home ?? (await mkdtemp(path.join(os.tmpdir(), "dc-e2e-")));
  const port = await freePort();
  const child: ChildProcess = spawn(
    process.execPath,
    [cli, "--no-open", "--port", String(port), ...extraArgs],
    {
      env: { ...process.env, DATACANVAS_HOME: dataHome },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  child.stdout?.on("data", (d) => (output += d));
  child.stderr?.on("data", (d) => (output += d));
  const exited = new Promise<number | null>((resolve) =>
    child.once("exit", (code) => resolve(code)),
  );

  const deadline = Date.now() + 30_000;
  let link: string | null = null;
  while (!link && Date.now() < deadline) {
    link = /http:\/\/127\.0\.0\.1:\d+\/\?token=[\w-]+/.exec(output)?.[0] ?? null;
    if (!link) await new Promise((r) => setTimeout(r, 50));
  }
  if (!link) {
    child.kill("SIGKILL");
    throw new Error(`DataCanvas did not start. Output:\n${output}`);
  }
  return {
    link,
    origin: `http://127.0.0.1:${port}`,
    port,
    home: dataHome,
    output: () => output,
    stop: async () => {
      child.kill("SIGINT");
      return exited;
    },
  };
}

export interface TestDb {
  name: string;
  host: string;
  port: number;
  user: string;
  password: string;
  url: string;
}

export const test = base.extend<{ app: RunningApp; writableApp: RunningApp; database: TestDb }>({
  // DataCanvas started with --enable-writes, for the editing tests.
  // eslint-disable-next-line no-empty-pattern
  writableApp: async ({}, use) => {
    const app = await startApp(undefined, ["--enable-writes"]);
    await use(app);
    await app.stop();
  },
  // eslint-disable-next-line no-empty-pattern
  app: async ({}, use) => {
    const app = await startApp();
    await use(app);
    await app.stop();
  },
  // eslint-disable-next-line no-empty-pattern
  database: async ({}, use, testInfo) => {
    if (!testDatabaseUrl()) testInfo.skip(true, "DATACANVAS_TEST_PG_URL is not set");
    const db = await createTestDatabase();
    const { host, port, username, password, database } = db.connection;
    await use({
      name: database,
      host,
      port,
      user: username,
      password,
      url: `postgresql://${username}:${password}@${host}:${port}/${database}?sslmode=disable`,
    });
    await db.dispose();
  },
});

export { expect };
