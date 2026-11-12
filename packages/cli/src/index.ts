/**
 * DataCanvas command-line launcher.
 *
 * What it does when the user runs `npx datacanvas`:
 *   1. checks the Node.js version,
 *   2. picks a port (4747, or the next free one),
 *   3. starts the bundled web server on 127.0.0.1,
 *   4. waits until it answers /api/health,
 *   5. opens the browser,
 *   6. on Ctrl+C / SIGTERM stops the server cleanly.
 *
 * This is the Phase 2 "walking skeleton": it proves the whole install path
 * works end to end. Phase 11 polishes it (single-instance detection, richer
 * messages, more checks).
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { DEFAULT_PORT } from "@datacanvas/shared-types";
import { openBrowser } from "./browser.js";
import { findFreePort, isPortFree } from "./port.js";
import { VERSION } from "./version.js";
import { startWebServer, stopWebServer, waitUntilHealthy } from "./web-server.js";

const MIN_NODE_MAJOR = 20;
const MIN_NODE_MINOR = 9; // matches "engines" (>=20.9.0), the floor Next.js requires

const HELP = `DataCanvas ${VERSION}
A local-first visual PostgreSQL explorer.

Usage: datacanvas [options]

Options:
  --port <number>   Port to listen on (default: ${DEFAULT_PORT}, or the next free port)
  --no-open         Do not open the browser automatically
  -v, --version     Print the version
  -h, --help        Show this help
`;

function fail(message: string): never {
  console.error(`Error: ${message}`);
  process.exit(1);
}

function checkNodeVersion(): void {
  const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
  if (major < MIN_NODE_MAJOR || (major === MIN_NODE_MAJOR && minor < MIN_NODE_MINOR)) {
    fail(
      `DataCanvas needs Node.js ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR} or newer, but this is ${process.versions.node}.\n` +
        "Install a current LTS version from https://nodejs.org and try again.",
    );
  }
}

async function main(): Promise<void> {
  checkNodeVersion();

  let values;
  try {
    ({ values } = parseArgs({
      options: {
        port: { type: "string" },
        "no-open": { type: "boolean", default: false },
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

  // The bundled web app sits next to the CLI: <package>/bin/datacanvas.mjs and
  // <package>/web/apps/web/server.js. (Layout is created by scripts/build-package.mjs.)
  const serverJs = fileURLToPath(new URL("../web/apps/web/server.js", import.meta.url));
  if (!existsSync(serverJs)) {
    fail(
      "The bundled web app was not found. If you are developing DataCanvas, run `npm run package` " +
        "and start the CLI from the .package folder.",
    );
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
  const server = startWebServer(serverJs, port);

  // Shutdown handling. `shuttingDown` stops a second Ctrl+C from racing the first.
  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log("\nStopping DataCanvas…");
    await stopWebServer(server);
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

  const url = `http://127.0.0.1:${port}`;
  console.log(`DataCanvas is running at ${url}`);
  console.log("Press Ctrl+C to stop.");
  if (!values["no-open"]) openBrowser(url);
}

main().catch((error: unknown) => {
  fail(error instanceof Error ? error.message : "Unexpected error");
});
