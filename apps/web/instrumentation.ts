/**
 * Runs once when the server starts (Next.js "instrumentation").
 *
 * Its only job: shut down cleanly. When the CLI stops the server (Ctrl+C or
 * SIGTERM), we close every database session and forget all credentials before
 * the process exits, instead of leaving PostgreSQL to notice a dropped socket.
 *
 * The CLI sets NEXT_MANUAL_SIG_HANDLE=1, which tells Next.js not to install
 * its own handlers; without that flag (for example `next dev`) we do nothing.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs" || !process.env.NEXT_MANUAL_SIG_HANDLE) return;

  const { installShutdownHandlers } = await import("./lib/server/shutdown");
  installShutdownHandlers();
}
