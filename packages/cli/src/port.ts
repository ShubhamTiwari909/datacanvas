/**
 * Port selection for the local server.
 */
import net from "node:net";

const HOST = "127.0.0.1";

/**
 * Resolve to true if we can bind `port` on the loopback interface right now.
 *
 * We test with the same host the real server will use (127.0.0.1), so the
 * answer matches what the server will experience. Note there is a small
 * unavoidable race: another program could take the port between this check
 * and the server starting. The CLI reports a clear error if that happens.
 */
export function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", () => resolve(false)); // EADDRINUSE, EACCES, ...
    probe.once("listening", () => probe.close(() => resolve(true)));
    probe.listen(port, HOST);
  });
}

/** Ask the operating system for any free port (binding port 0 lets the OS choose). */
function getOsAssignedPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, HOST, () => {
      const address = probe.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      probe.close(() => (port > 0 ? resolve(port) : reject(new Error("No free port available"))));
    });
  });
}

/**
 * Find a free port, preferring `preferred`.
 *
 * Tries `preferred`, then the next `maxAttempts - 1` ports in order, so the
 * address stays predictable (4747, 4748, ...). If none is free, falls back to
 * whatever port the OS hands out.
 */
export async function findFreePort(preferred: number, maxAttempts = 20): Promise<number> {
  for (let offset = 0; offset < maxAttempts; offset += 1) {
    const candidate = preferred + offset;
    if (candidate > 65535) break;
    if (await isPortFree(candidate)) return candidate;
  }
  return getOsAssignedPort();
}
