/**
 * Starting, health-checking and stopping the bundled Next.js server.
 *
 * The published package contains Next.js' "standalone" build: a ready-to-run
 * `server.js`. We run it as a child process (instead of importing it) so that
 * it has its own lifecycle, so we can stop it cleanly, and so a crash in it
 * cannot take the CLI down silently.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

export interface WebServer {
  /** The child process, exposed so callers can react to unexpected exits. */
  child: ChildProcess;
  /** Resolves with the exit code when the server process ends (null if killed by a signal). */
  exited: Promise<number | null>;
}

/** Launch `server.js` bound to loopback only, on the given port. */
export function startWebServer(serverJsPath: string, port: number): WebServer {
  const child = spawn(process.execPath, [serverJsPath], {
    // Run with the same Node.js binary that runs the CLI.
    env: {
      ...process.env,
      NODE_ENV: "production",
      PORT: String(port),
      // SECURITY: Next.js reads HOSTNAME to choose the interface to listen on.
      // Without this it would listen on all interfaces (0.0.0.0) and expose
      // the app to the local network. Never remove or loosen this.
      HOSTNAME: "127.0.0.1",
    },
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
