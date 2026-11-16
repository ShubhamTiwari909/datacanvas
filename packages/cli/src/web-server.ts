/**
 * Starting, health-checking and stopping the bundled Next.js server.
 *
 * The published package contains Next.js' "standalone" build: a ready-to-run
 * `server.js`. We run it as a child process (instead of importing it) so that
 * it has its own lifecycle, so we can stop it cleanly, and so a crash in it
 * cannot take the CLI down silently.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

export interface WebServer {
  /** The child process, exposed so callers can react to unexpected exits. */
  child: ChildProcess;
  /** Resolves with the exit code when the server process ends (null if killed by a signal). */
  exited: Promise<number | null>;
}

/** A fresh random secret for this run: 32 bytes (256 bits), URL-safe. Never reused, never stored. */
export function generateSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

/** The variable through which the CLI tells the server that writes are enabled. Set by the CLI only. */
export const ENABLE_WRITES_ENV = "DATACANVAS_ENABLE_WRITES";

/**
 * The environment the web server runs with. Exported so a test can pin down
 * the security-relevant values (loopback only, token, no telemetry, writes).
 */
export function buildServerEnv(
  port: number,
  sessionToken: string,
  base: NodeJS.ProcessEnv = process.env,
  options: { enableWrites?: boolean } = {},
): NodeJS.ProcessEnv {
  // SECURITY: writes are switched on by the `--enable-writes` FLAG only
  // (decision 125). A value inherited from the shell is dropped, so a line in a
  // shell profile can never turn writes on behind the person's back.
  const rest = { ...base };
  delete rest[ENABLE_WRITES_ENV];
  return {
    ...rest,
    ...(options.enableWrites ? { [ENABLE_WRITES_ENV]: "1" } : {}),
    NODE_ENV: "production",
    PORT: String(port),
    // SECURITY: Next.js reads HOSTNAME to choose the interface to listen on.
    // Without this it would listen on all interfaces (0.0.0.0) and expose
    // the app to the local network. Never remove or loosen this.
    HOSTNAME: "127.0.0.1",
    // SECURITY: the per-run secret the server requires on every request.
    DATACANVAS_SESSION_TOKEN: sessionToken,
    // Tell Next.js NOT to install its own SIGINT/SIGTERM handlers: the app's
    // instrumentation.ts installs one that first closes database connections.
    NEXT_MANUAL_SIG_HANDLE: "1",
    // PRIVACY: nothing leaves the machine. Next.js would otherwise send
    // anonymous usage data from a running server.
    NEXT_TELEMETRY_DISABLED: "1",
  };
}

/** Launch `server.js` bound to loopback only, on the given port, protected by `sessionToken`. */
export function startWebServer(
  serverJsPath: string,
  port: number,
  sessionToken: string,
  options: { enableWrites?: boolean } = {},
): WebServer {
  const child = spawn(process.execPath, [serverJsPath], {
    // Run with the same Node.js binary that runs the CLI.
    env: buildServerEnv(port, sessionToken, process.env, options),
    stdio: ["ignore", "inherit", "inherit"],
  });

  const exited = new Promise<number | null>((resolve) => {
    child.once("exit", (code) => resolve(code));
    child.once("error", () => resolve(1)); // failed to spawn at all
  });

  return { child, exited };
}

/**
 * Poll `/api/health` until the server answers, the process dies, or we time out.
 * Returns true when healthy. We wait for this before opening the browser so the
 * user never lands on a "connection refused" page.
 */
export async function waitUntilHealthy(
  server: WebServer,
  port: number,
  timeoutMs = 30_000,
): Promise<boolean> {
  let dead = false;
  void server.exited.then(() => {
    dead = true;
  });

  const deadline = Date.now() + timeoutMs;
  while (!dead && Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
        signal: AbortSignal.timeout(1000),
      });
      if (response.ok) return true;
    } catch {
      // Not listening yet; try again shortly.
    }
    await sleep(200);
  }
  return false;
}

/**
 * Ask the server to stop (SIGTERM) and wait for it. If it ignores us for
 * `graceMs`, force-kill it so the CLI never hangs on shutdown.
 */
export async function stopWebServer(server: WebServer, graceMs = 5000): Promise<void> {
  if (server.child.exitCode !== null || server.child.signalCode !== null) return; // already gone
  server.child.kill("SIGTERM");
  const timedOut = await Promise.race([server.exited.then(() => false), sleep(graceMs, true)]);
  if (timedOut) server.child.kill("SIGKILL");
}
