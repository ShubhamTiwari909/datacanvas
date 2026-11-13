/**
 * Graceful shutdown: on SIGINT/SIGTERM close the database sessions, then exit.
 *
 * A time limit guarantees the process always ends: a database that does not
 * answer the goodbye must not keep the server alive.
 */
import { disposeServerContext } from "./context";

/** Longest we wait for connections to close before exiting anyway. */
export const SHUTDOWN_GRACE_MS = 3000;

/** Dispose with a deadline. Resolves either way; never throws. */
export async function disposeWithin(
  dispose: () => Promise<void>,
  graceMs: number = SHUTDOWN_GRACE_MS,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, graceMs);
  });
  try {
    await Promise.race([dispose().catch(() => {}), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

export function installShutdownHandlers(): void {
  let stopping = false;
  const handler = (signal: NodeJS.Signals): void => {
    if (stopping) return; // a second signal must not start a second shutdown
    stopping = true;
    void disposeWithin(disposeServerContext).then(() => {
      process.exit(signal === "SIGINT" ? 130 : 143);
    });
  };
  process.on("SIGINT", handler);
  process.on("SIGTERM", handler);
}
