/**
 * Open a URL in the user's default browser.
 *
 * Uses each operating system's built-in launcher, so no dependency is needed.
 * Failure is never fatal: on a headless server or when the launcher is missing
 * the user just opens the URL that we print.
 */
import { spawn } from "node:child_process";

export function openBrowser(url: string): void {
  let command: string;
  let args: string[];

  if (process.platform === "darwin") {
    command = "open";
    args = [url];
  } else if (process.platform === "win32") {
    // `start` is a cmd.exe built-in. The empty "" is the window title argument;
    // without it `start` would treat a quoted URL as the title.
    command = "cmd";
    args = ["/c", "start", '""', url];
  } else {
    command = "xdg-open";
    args = [url];
  }

  try {
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.on("error", () => {
      // Launcher not found (e.g. no xdg-open): ignore; the URL was printed.
    });
    child.unref(); // don't keep the CLI alive waiting for the browser
  } catch {
    // Same: never let a failed browser launch crash the app.
  }
}
