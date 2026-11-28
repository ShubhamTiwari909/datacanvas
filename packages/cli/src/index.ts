/**
 * DataCanvas command-line launcher.
 *
 * What it does when the user runs `npx @shubhamtiwari909/datacanvas`:
 *   1. checks the Node.js version,
 *   2. picks a port (4747, or the next free one),
 *   3. starts the bundled web server on 127.0.0.1 (or, in a container only, on all interfaces: see host-option.ts),
 *   4. waits until it answers /api/health,
 *   5. opens the browser,
 *   6. on Ctrl+C / SIGTERM stops the server cleanly.
 *
 * Before starting it creates the data folder on the first run, and if a
 * DataCanvas is already running it opens that one instead (see instance.ts).
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { DEFAULT_PORT } from "@datacanvas/shared-types";
import { openBrowser } from "./browser.js";
import { ensureDataDir, resolveDataDir } from "./data-dir.js";
import {
  ALL_INTERFACES_HOST,
  ALLOW_ANY_INTERFACE_ENV,
  LOOPBACK_HOST,
  resolveHost,
} from "./host-option.js";
import {
  findRunningInstance,
  isDataCanvasHealthy,
  removeInstance,
  writeInstance,
} from "./instance.js";
import { isSupportedNode, unsupportedNodeMessage } from "./node-version.js";
import { runBridge } from "./mcp-bridge.js";
import { removeMcpFile, writeMcpFile } from "./mcp-file.js";
import { findFreePort, isPortFree } from "./port.js";
import { VERSION } from "./version.js";
import {
  generateSessionToken,
  startWebServer,
  stopWebServer,
  waitUntilHealthy,
} from "./web-server.js";

const HELP = `DataCanvas ${VERSION}
A local-first visual PostgreSQL explorer.

Usage: datacanvas [options]
       datacanvas schema check --baseline <file> [--format markdown|json]
       datacanvas mcp      A bridge for a Claude app: connects it to the running DataCanvas (read only)

Options:
  --port <number>   Port to listen on (default: ${DEFAULT_PORT}, or the next free port)
  --host <address>  Address to listen on: ${LOOPBACK_HOST} (default) or ${ALL_INTERFACES_HOST}, which is accepted only
                    when ${ALLOW_ANY_INTERFACE_ENV}=1 is set (for a container; see docs/docker.md)
  --no-open         Do not open the browser automatically
  --enable-writes   Allow editing rows and changing table structure on local databases (off by default)
  -v, --version     Print the version
  -h, --help        Show this help
`;

/** Printed at every start with --enable-writes (Appendix A of docs/data-editing-plan.md). */
const WRITES_NOTICE =
  "Writes are enabled. Changes are committed immediately and cannot be undone. " +
  "Connect with a role that can only do what you need.";

function fail(message: string): never {
  console.error(`Error: ${message}`);
  process.exit(1);
}

function checkNodeVersion(): void {
  if (!isSupportedNode(process.versions.node)) fail(unsupportedNodeMessage(process.versions.node));
}

async function main(): Promise<void> {
  checkNodeVersion();

  // `datacanvas mcp`: the stdio bridge a Claude app starts (docs/mcp-server-plan.md, section 5.3). Nothing but protocol
  // may go to stdout, so it runs before anything that prints.
  if (process.argv[2] === "mcp") {
    await runBridge(resolveDataDir());
    return;
  }

  if (process.argv[2] === "schema") {
    const { runSchemaCommand } = await import("./schema-check.js");
    process.exitCode = await runSchemaCommand(process.argv.slice(3));
    return;
  }

  let values;
  try {
    ({ values } = parseArgs({
      options: {
        port: { type: "string" },
        host: { type: "string" },
        "no-open": { type: "boolean", default: false },
        "enable-writes": { type: "boolean", default: false },
        version: { type: "boolean", short: "v", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
      strict: true, // unknown flags are an error instead of being silently ignored
    }));
  } catch (error) {
    fail(`${error instanceof Error ? error.message : "Invalid arguments"}\n\n${HELP}`);
  }

  if (values.help) {
    console.log(HELP);
    return;
  }
  if (values.version) {
    console.log(VERSION);
    return;
  }

  // `--host`: loopback unless the environment allows all interfaces (a container). Refused in plain words otherwise.
  const hostChoice = resolveHost(values.host);
  if (!hostChoice.ok) fail(hostChoice.message);
  const host = hostChoice.host;

  // The bundled web app sits next to the CLI: <package>/bin/datacanvas.mjs and
  // <package>/web/apps/web/server.js. (Layout is created by scripts/build-package.mjs.)
  const serverJs = fileURLToPath(new URL("../web/apps/web/server.js", import.meta.url));
  if (!existsSync(serverJs)) {
    fail(
      "The bundled web app was not found. If you are developing DataCanvas, run `pnpm run package` " +
        "and start the CLI from the .package folder.",
    );
  }

  // First run: create the data folder and say hello. The folder is owner-only.
  const dataDir = resolveDataDir();
  const firstRun = await ensureDataDir(dataDir).catch(() => false);
  if (firstRun) {
    console.log(
      `Welcome to DataCanvas! Your data stays in ${dataDir} (nothing leaves your computer).`,
    );
  }

  // Already running? Open that one instead of starting a second server. An
  // explicit --port that differs means "I want a new one on that port".
  const enableWrites = values["enable-writes"];
  const running = await findRunningInstance(dataDir, isDataCanvasHealthy);
  if (running && (values.port === undefined || Number(values.port) === running.port)) {
    // Never open a running DataCanvas whose write mode differs from what was asked for:
    // the person would believe writes are on (or off) when they are not.
    if (running.writes !== enableWrites) {
      fail(
        running.writes
          ? "DataCanvas is already running WITH writes enabled. Stop it (Ctrl+C in its window) and start again without --enable-writes."
          : "DataCanvas is already running without writes. Stop it (Ctrl+C in its window) and start again with --enable-writes.",
      );
    }
    const link = `http://127.0.0.1:${running.port}/?token=${running.token}`;
    console.log(`DataCanvas is already running. Open this link in your browser:\n  ${link}`);
    if (!values["no-open"]) openBrowser(link);
    return;
  }

  // Port: an explicit --port must be honoured exactly (fail if busy); the
  // default port silently falls back to the next free one.
  let port: number;
  if (values.port !== undefined) {
    port = Number(values.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      fail(`--port must be a whole number between 1 and 65535 (got "${values.port}").`);
    }
    if (!(await isPortFree(port))) {
      fail(`Port ${port} is already in use. Choose another with --port, or omit it.`);
    }
  } else {
    port = await findFreePort(DEFAULT_PORT);
    if (port !== DEFAULT_PORT) {
      console.log(`Port ${DEFAULT_PORT} is in use, using ${port} instead.`);
    }
  }

  console.log(`DataCanvas ${VERSION}: starting…`);
  // A new secret for every run. Only this process and the server it starts know it.
  const sessionToken = generateSessionToken();
  // The token of `/mcp` is another secret, never the session token: it is accepted on that one route only.
  const mcpToken = generateSessionToken();
  const server = startWebServer(serverJs, port, sessionToken, { enableWrites, mcpToken, host });

  // Shutdown handling. `shuttingDown` stops a second Ctrl+C from racing the first.
  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log("\nStopping DataCanvas…");
    await stopWebServer(server);
    await removeInstance(dataDir, process.pid).catch(() => {});
    await removeMcpFile(dataDir, process.pid).catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  // If the server dies on its own (crash), report it and exit non-zero.
  void server.exited.then((code) => {
    if (!shuttingDown) {
      console.error(`The DataCanvas server stopped unexpectedly (exit code ${code ?? "unknown"}).`);
      process.exit(1);
    }
  });

  if (!(await waitUntilHealthy(server, port))) {
    // Mark as intentional first, otherwise the "stopped unexpectedly" handler
    // above would also fire when we stop the server ourselves.
    shuttingDown = true;
    await stopWebServer(server);
    fail("The server did not become ready in time.");
  }

  // The first page load carries the token; the app swaps it for an HttpOnly
  // cookie and removes it from the address bar. Anyone without this link (other
  // programs, other websites) is refused. Treat the link like a password for
  // as long as DataCanvas is running.
  const url = `http://127.0.0.1:${port}/?token=${sessionToken}`;
  console.log(`DataCanvas is running. Open this link in your browser:\n  ${url}`);
  console.log("The link is private to this run. Press Ctrl+C to stop.");
  if (host === ALL_INTERFACES_HOST) {
    console.log(
      `Listening on all interfaces of this container. Publish the port to the loopback address of the host only ` +
        `(docker run -p ${LOOPBACK_HOST}:${port}:${port}), and keep the host port equal to ${port}: the Host check accepts only ` +
        `${LOOPBACK_HOST}:${port} and localhost:${port}.`,
    );
  }
  if (enableWrites) console.log(WRITES_NOTICE);
  await writeInstance(dataDir, {
    pid: process.pid,
    port,
    token: sessionToken,
    version: VERSION,
    writes: enableWrites,
  }).catch(
    () => {}, // not being able to write it only disables "open the running one"
  );
  // For `datacanvas mcp`, the bridge a Claude app starts (mode 0600, deleted on shutdown).
  await writeMcpFile(dataDir, { pid: process.pid, port, token: mcpToken }).catch(() => {});
  if (!values["no-open"]) openBrowser(url);
}

main().catch((error: unknown) => {
  fail(error instanceof Error ? error.message : "Unexpected error");
});
